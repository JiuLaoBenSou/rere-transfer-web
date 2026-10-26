// Codex / 2026-10-25. Signaling is separate from file traffic; host owns negotiation.
import { apiURL } from './app-config.js';
const NEGOTIATION_WAIT = 30000;
export class RoomLink {
  constructor(room, hooks = {}) {
    this.room = room; this.hooks = hooks; this.abort = new AbortController();
    this.generation = room.generation || 0; this.pendingIce = []; this.peer = room.role === 'guest' || room.peerPresent; this.lastAttempt = 0;
    this.attempts = 0; this.localCandidates = 0; this.remoteCandidates = 0;
    this.listen();
    this.tick = setInterval(() => {
      if (Date.now() >= room.expiresAt) return this.end('房间已过期，请重新创建。');
      if (this.peer && !this.blocked && !this.connected && Date.now() - this.lastAttempt >= NEGOTIATION_WAIT) {
        if (this.attempts >= 3) { this.blocked = true; this.hooks.onBlocked?.('暂时无法直连。请检查双方网络及浏览器的本地网络权限，再点「重新连接」。'); return; }
        if (this.lastAttempt) this.hooks.onRetryError?.('尚未建立直连。请确认双方在同一网络并保持页面打开；访客网络、网络隔离或浏览器限制可能阻止连接。');
        this.reconnect();
      }
    }, 1000);
  }
  get connected() { return this.channel?.readyState === 'open'; }
  async request(action, method = 'GET', data) {
    const response = await fetch(apiURL(`/api/${this.room.group ? 'groups' : 'rooms'}/${this.room.roomId}/${action}`), {
      method, signal: this.abort.signal, headers: { Authorization: `Bearer ${this.room.token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw Object.assign(new Error(value.error || '连接服务暂时不可用。'), { status: response.status }); }
    return response;
  }
  async signal(type, data, generation = this.generation) { await this.request('signal', 'POST', { type, data, generation }); }
  async listen() {
    if (this.room.transport === 'websocket') return this.listenSocket();
    let failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const response = await this.request('events'); failures = 0; this.hooks.onSignaling?.(true);
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
        while (!this.abort.signal.aborted) {
          const { value, done } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const data = block.split('\n').find(line => line.startsWith('data: '));
            if (data) {
              try { await this.handle(JSON.parse(data.slice(6))); }
              catch { this.hooks.onRetryError?.('直连协商未完成，请保持双方页面打开。'); }
            }
          }
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        if ([401, 404].includes(error.status)) return this.end(error.message);
      }
      if (this.abort.signal.aborted) return;
      this.hooks.onSignaling?.(false);
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(5000, 500 * 2 ** failures++)); this.abort.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  async listenSocket() {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      await new Promise(resolve => {
        const url = new URL(apiURL(`/api/${this.room.group ? 'groups' : 'rooms'}/${this.room.roomId}/socket`)); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(url); this.ws = ws; let heartbeat, settled = false, lastPong = Date.now();
        const authTimer = setTimeout(() => ws.close(), 10000);
        const stop = () => { if (settled) return; settled = true; clearTimeout(authTimer); clearInterval(heartbeat); this.abort.signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { ws.close(); stop(); };
        this.abort.signal.addEventListener('abort', abort, { once: true });
        ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: this.room.token }));
        let chain = Promise.resolve();
        ws.onmessage = event => {
          chain = chain.then(async () => {
            if (this.ws !== ws || this.abort.signal.aborted) return;
            if (event.data === 'pong') { lastPong = Date.now(); return; }
            const message = JSON.parse(event.data);
            if (message.type === 'ready') {
              clearTimeout(authTimer); failures = 0; lastPong = Date.now(); this.hooks.onSignaling?.(true);
              heartbeat = setInterval(() => {
                if (ws.readyState !== 1) { stop(); return; }
                if (Date.now() - lastPong >= 45000) { ws.close(); stop(); return; }
                if (ws.readyState === 1) ws.send('ping');
              }, 15000); return;
            }
            if (message.type === 'auth-error') { this.end('房间身份失效或重复连接，请重新加入。'); return; }
            await this.handle(message);
          }).catch(() => this.hooks.onRetryError?.('连接协商未完成，请保持双方页面打开。'));
        };
        ws.onclose = event => { stop(); if (this.ws === ws && event?.code === 4001 && !this.abort.signal.aborted) this.end('此设备的房间已在另一个页面恢复，请使用新页面。'); };
        ws.onerror = () => { ws.close(); stop(); };
      });
      if (this.abort.signal.aborted) return;
      this.hooks.onSignaling?.(false);
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, Math.min(5000, 500 * 2 ** failures++)); this.abort.signal.addEventListener('abort', done, { once: true });
      });
    }
  }
  makePeer(generation) {
    this.generation = generation; this.pendingIce = []; this.described = false; this.localIce = [];
    this.localCandidates = 0; this.remoteCandidates = 0;
    const old = this.pc; this.pc = null; old?.close();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }); this.pc = pc; this.channel = null;
    pc.onicecandidate = event => {
      if (this.pc !== pc) return;
      if (!event.candidate) { this.hooks.onDiagnostics?.({ local: this.localCandidates, remote: this.remoteCandidates, gathering: 'complete', ice: pc.iceConnectionState }); return; }
      this.localCandidates++;
      this.hooks.onDiagnostics?.({ local: this.localCandidates, remote: this.remoteCandidates, gathering: pc.iceGatheringState, ice: pc.iceConnectionState });
      if (!this.described) this.localIce.push(event.candidate.toJSON());
      else this.signal('ice', event.candidate.toJSON(), generation).catch(error => this.hooks.onRetryError?.(error.message));
    };
    pc.ondatachannel = event => { if (this.pc === pc) this.attach(event.channel, pc); };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.abort.signal.aborted) return;
      if (['failed', 'closed'].includes(pc.connectionState)) this.pause();
      if (pc.connectionState === 'disconnected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') { pc.close(); this.pause(); } }, 2000);
      }
    };
    pc.oniceconnectionstatechange = () => { if (this.pc === pc) this.hooks.onDiagnostics?.({ local: this.localCandidates, remote: this.remoteCandidates, gathering: pc.iceGatheringState, ice: pc.iceConnectionState }); };
    this.hooks.onConnecting?.(); return pc;
  }
  attach(channel, pc) {
    this.channel = channel; this.hooks.onChannel?.(channel);
    let opened = false;
    const open = () => { if (!opened && this.pc === pc) { opened = true; this.attempts = 0; this.blocked = false; this.hooks.onConnected?.(); } };
    channel.addEventListener('open', open);
    if (channel.readyState === 'open') open();
    channel.addEventListener('close', () => { if (this.pc === pc && !this.abort.signal.aborted) this.pause(); });
  }
  pause() {
    this.hooks.onPaused?.(); clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.reconnect(), 500);
  }
  async describedSignal(type, pc, generation) {
    await this.signal(type, pc.localDescription.toJSON(), generation);
    if (this.pc !== pc) return;
    this.described = true;
    for (const candidate of this.localIce.splice(0)) await this.signal('ice', candidate, generation);
  }
  async reconnect(force = false) {
    if (this.abort.signal.aborted || this.connected || this.negotiating || !this.peer) return;
    if (force) { this.blocked = false; this.attempts = 0; }
    if (this.blocked) return;
    // Late signaling and socket reconnects must not discard an offer still in flight.
    const pending = !['connected', 'failed', 'closed'].includes(this.pc?.connectionState);
    if (!force && pending && this.lastAttempt && Date.now() - this.lastAttempt < NEGOTIATION_WAIT) return;
    this.lastAttempt = Date.now(); this.negotiating = true; this.attempts++;
    try {
      if (this.room.role === 'host') {
        const generation = this.generation + 1, pc = this.makePeer(generation);
        this.attach(pc.createDataChannel('rere-transfer-v2', { ordered: true }), pc);
        await pc.setLocalDescription(await pc.createOffer());
        await this.describedSignal('offer', pc, generation);
      } else { this.hooks.onConnecting?.(); await this.signal('restart', {}); }
    } catch (error) { if (!this.abort.signal.aborted) this.hooks.onRetryError?.(error.message); }
    finally { this.negotiating = false; }
  }
  async handle(message) {
    if (message.type === 'closed') return this.end(message.reason === 'expired' ? '房间已过期，请重新创建。' : '房间已结束，请重新创建。');
    if (['peer', 'peer-returned'].includes(message.type)) {
      if (message.type === 'peer-returned' || !this.peer) { this.blocked = false; this.attempts = 0; }
      this.peer = true; if (!this.connected) await this.reconnect(); return;
    }
    if (message.type === 'peer-left') { this.peer = false; const pc = this.pc; this.pc = null; pc?.close(); this.channel = null; this.hooks.onPeerLeft?.(); return; }
    if (message.type === 'restart') { if (this.room.role === 'host') await this.reconnect(); return; }
    const generation = message.generation;
    if (!Number.isSafeInteger(generation) || generation < this.generation) return;
    if (message.type === 'offer' && this.room.role === 'guest') {
      this.blocked = false;
      const pc = this.makePeer(generation); this.lastAttempt = Date.now();
      await pc.setRemoteDescription(message.data); await pc.setLocalDescription(await pc.createAnswer());
      await this.describedSignal('answer', pc, generation); return;
    }
    if (generation !== this.generation || !this.pc) return;
    if (message.type === 'answer' && this.room.role === 'host') {
      await this.pc.setRemoteDescription(message.data);
      for (const candidate of this.pendingIce.splice(0)) await this.pc.addIceCandidate(candidate);
    } else if (message.type === 'ice') {
      this.remoteCandidates++;
      this.hooks.onDiagnostics?.({ local: this.localCandidates, remote: this.remoteCandidates, gathering: this.pc.iceGatheringState, ice: this.pc.iceConnectionState });
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.data); else this.pendingIce.push(message.data);
    }
  }
  end(reason) { if (this.abort.signal.aborted) return; this.dispose(); this.hooks.onEnded?.(reason); }
  dispose() {
    this.abort.abort(); clearInterval(this.tick); clearTimeout(this.retryTimer); clearTimeout(this.disconnectTimer);
    const ws = this.ws; this.ws = null; ws?.close();
    const pc = this.pc; this.pc = null; pc?.close(); this.channel = null;
  }
}
