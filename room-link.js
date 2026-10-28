// Codex / 2026-10-25. Signaling is separate from file traffic; host owns negotiation.
import { apiURL } from './app-config.js';
const NEGOTIATION_WAIT = 30000;
// Only classifications leave this module in diagnostics, never candidate addresses.
export function candidateSummary(value){
 const raw=typeof value==='string'?value:value?.candidate;if(!raw)return null;const words=raw.trim().split(/\s+/),address=words[4]?.toLowerCase()||'';
 const type=raw.match(/\btyp (host|srflx|prflx|relay)\b/)?.[1]||'unknown';let addressKind='unknown';
 if(address.endsWith('.local'))addressKind='mdns';
 else if(/^\d+\.\d+\.\d+\.\d+$/.test(address)){const n=address.split('.').map(Number);if(n.every(v=>v>=0&&v<=255))addressKind=n[0]===10||n[0]===127||n[0]===192&&n[1]===168||n[0]===172&&n[1]>=16&&n[1]<=31||n[0]===169&&n[1]===254?'private-ipv4':'public-ipv4';}
 else if(address.includes(':'))addressKind=/^fe[89ab]/.test(address)?'link-local-ipv6':/^f[cd]/.test(address)?'private-ipv6':'ipv6';
 return{type,protocol:['udp','tcp'].includes(words[2]?.toLowerCase())?words[2].toLowerCase():'unknown',addressKind,tcpType:raw.match(/\btcptype (active|passive|so)\b/)?.[1]||'none'};
}
export function iceStatsSummary(stats){
 const out={pairs:{},requestsSent:0,responsesReceived:0,bytesSent:0,bytesReceived:0};
 stats.forEach(value=>{if(value.type!=='candidate-pair')return;const state=['frozen','waiting','in-progress','failed','succeeded'].includes(value.state)?value.state:'unknown';out.pairs[state]=(out.pairs[state]||0)+1;for(const field of ['requestsSent','responsesReceived','bytesSent','bytesReceived'])if(Number.isFinite(value[field])&&value[field]>=0)out[field]+=value[field];});return out;
}
export class RoomLink {
  constructor(room, hooks = {}) {
    this.room = room; this.hooks = hooks; this.abort = new AbortController();
    this.generation = room.generation || 0; this.pendingIce = []; this.peer = room.role === 'guest' || room.peerPresent; this.lastAttempt = 0;
    this.attempts = 0; this.localCandidates = 0; this.remoteCandidates = 0;
    this.negotiationStartedAt = null;
    this.listen();
    this.tick = setInterval(() => {
      if (Date.now() >= room.expiresAt) return this.end('房间已过期，请重新创建。');
      if(this.peer&&!this.blocked&&!this.connected&&Number.isFinite(this.negotiationStartedAt)&&Date.now()-this.negotiationStartedAt>=90000){this.blocked=true;clearTimeout(this.retryTimer);this.hooks.onBlocked?.('设备间连接检查未通过，已停止自动重试。可复制连接诊断查看原因，再手动重新连接。');return;}
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
    this.negotiationStartedAt ??= Date.now();
    this.generation = generation; this.pendingIce = this.earlyIce?.get(generation) || []; this.described = false; this.localIce = [];
    for (const key of this.earlyIce?.keys() || []) if (key <= generation) this.earlyIce.delete(key);
    this.localCandidates = 0; this.remoteCandidates = this.pendingIce.length;
    this.localRouteCounts={};this.remoteRouteCounts={};this.remoteApplied=0;this.candidateErrors=[];
    for(const value of this.pendingIce)this.recordCandidate('remote',value);
    const old = this.pc; this.pc = null; old?.close();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] }); this.pc = pc; this.channel = null; this.chatChannel = null;
    pc.onicecandidate = event => {
      if (this.pc !== pc) return;
      if (!event.candidate) { this.emitIceDiagnostics(pc); return; }
      this.localCandidates++;
      this.recordCandidate('local',event.candidate);this.emitIceDiagnostics(pc);
      if (!this.described) this.localIce.push(event.candidate.toJSON());
      else this.signal('ice', event.candidate.toJSON(), generation).catch(error => this.hooks.onRetryError?.(error.message));
    };
    pc.ondatachannel = event => { if (this.pc === pc) { if (event.channel.label === 'rere-chat-v1' && this.room.chat) this.attachChat(event.channel, pc); else if (event.channel.label !== 'rere-chat-v1') this.attach(event.channel, pc); else event.channel.close(); } };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.abort.signal.aborted) return;
      if (['failed', 'closed'].includes(pc.connectionState)) this.pause();
      if (pc.connectionState === 'disconnected') {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') { pc.close(); this.pause(); } }, 2000);
      }
    };
    pc.onicecandidateerror=event=>{if(this.pc!==pc)return;const code=Number.isInteger(event.errorCode)?event.errorCode:0;if(!this.candidateErrors.includes(code))this.candidateErrors.push(code);this.emitIceDiagnostics(pc);};
    pc.oniceconnectionstatechange = () => this.emitIceDiagnostics(pc);
    this.hooks.onConnecting?.(); return pc;
  }
  recordCandidate(side,value){const summary=candidateSummary(value);if(!summary)return;const counts=side==='local'?this.localRouteCounts:this.remoteRouteCounts;if(!counts)return;const key=[summary.type,summary.protocol,summary.addressKind,summary.tcpType].join('/');counts[key]=(counts[key]||0)+1;}
  emitIceDiagnostics(pc){if(this.pc!==pc)return;this.hooks.onDiagnostics?.({local:this.localCandidates,remote:this.remoteCandidates,gathering:pc.iceGatheringState,ice:pc.iceConnectionState,generation:this.generation,remoteApplied:this.remoteApplied||0,localRoutes:{...this.localRouteCounts},remoteRoutes:{...this.remoteRouteCounts},candidateErrors:[...(this.candidateErrors||[])]});}
  async inspectConnectivity(){const pc=this.pc;if(!pc?.getStats)return{supported:false};try{const stats=await pc.getStats();if(this.pc!==pc)return{supported:false};return{supported:true,...iceStatsSummary(stats)};}catch{return{supported:false};}}
  async applyRemoteCandidate(pc,value){await pc.addIceCandidate(value);if(this.pc===pc){this.remoteApplied=(this.remoteApplied||0)+1;this.emitIceDiagnostics(pc);}}
  attach(channel, pc) {
    this.channel = channel; this.hooks.onChannel?.(channel);
    let opened = false;
    const open = () => { if (!opened && this.pc === pc) { opened = true; this.attempts = 0; this.blocked = false; this.negotiationStartedAt=null; this.hooks.onConnected?.(); } };
    channel.addEventListener('open', open);
    if (channel.readyState === 'open') open();
    channel.addEventListener('close', () => { if (this.pc === pc && !this.abort.signal.aborted) this.pause(); });
  }
  attachChat(channel, pc) {
    this.chatChannel = channel; this.hooks.onChatChannel?.(channel);
    const update = () => { if (this.pc === pc && !this.abort.signal.aborted) this.hooks.onChatState?.(); };
    channel.addEventListener('open', update); channel.addEventListener('close', update); if (channel.readyState === 'open') update();
    channel.addEventListener('close', () => {
      if (this.pc === pc && !this.abort.signal.aborted && this.room.role === 'host' && pc.connectionState === 'connected') this.attachChat(pc.createDataChannel('rere-chat-v1', { ordered: true }), pc);
    });
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
  async reconnect(force = false, remote = false) {
    if (this.abort.signal.aborted || (this.connected && !force) || this.negotiating || !this.peer) return;
    if (force && !remote) { this.blocked = false; this.attempts = 0; this.negotiationStartedAt = null; }
    if (this.blocked) return;
    // Late signaling and socket reconnects must not discard an offer still in flight.
    const pending = !['connected', 'failed', 'closed'].includes(this.pc?.connectionState);
    if (!force && pending && this.lastAttempt && Date.now() - this.lastAttempt < NEGOTIATION_WAIT) return;
    this.lastAttempt = Date.now(); this.negotiating = true; this.attempts++;
    this.negotiationStartedAt ??= Date.now();
    try {
      if (this.room.role === 'host') {
        const generation = this.generation + 1, pc = this.makePeer(generation);
        this.attach(pc.createDataChannel('rere-transfer-v2', { ordered: true }), pc);
        if (this.room.chat) this.attachChat(pc.createDataChannel('rere-chat-v1', { ordered: true }), pc);
        await pc.setLocalDescription(await pc.createOffer());
        await this.describedSignal('offer', pc, generation);
      } else { this.hooks.onConnecting?.(); await this.signal('restart', {}); }
    } catch (error) { if (!this.abort.signal.aborted) this.hooks.onRetryError?.(error.message); }
    finally { this.negotiating = false; }
  }
  async handle(message) {
    if (message.type === 'closed') return this.end(message.reason === 'expired' ? '房间已过期，请重新创建。' : '房间已结束，请重新创建。');
    if (['peer', 'peer-returned'].includes(message.type)) {
      if (message.type === 'peer-returned' || !this.peer) { this.blocked = false; this.attempts = 0; this.negotiationStartedAt=null; }
      this.peer = true; if (!this.connected) await this.reconnect(); return;
    }
    if (message.type === 'peer-left') { this.peer = false; const pc = this.pc; this.pc = null; pc?.close(); this.channel = null; this.hooks.onPeerLeft?.(); return; }
    if (message.type === 'restart') { if (this.room.role === 'host' && message.generation >= this.generation) await this.reconnect(true,true); return; }
    const generation = message.generation;
    if (!Number.isSafeInteger(generation) || generation < this.generation) return;
    if (message.type === 'ice' && (!this.pc || generation > this.generation)) {
      this.earlyIce ||= new Map(); if (!this.earlyIce.has(generation)) this.earlyIce.set(generation, []);
      const list = this.earlyIce.get(generation); if (list.length < 64) list.push(message.data);
      while (this.earlyIce.size > 3) this.earlyIce.delete(this.earlyIce.keys().next().value); return;
    }
    if (message.type === 'offer' && this.room.role === 'guest') {
      if(this.blocked)return;
      if (generation === this.generation && this.pc?.remoteDescription?.type === 'offer' && this.pc.localDescription?.type === 'answer') { await this.describedSignal('answer', this.pc, generation); return; }
      const pc = this.makePeer(generation); this.lastAttempt = Date.now();
      await pc.setRemoteDescription(message.data); for (const candidate of this.pendingIce.splice(0)) await this.applyRemoteCandidate(pc,candidate); await pc.setLocalDescription(await pc.createAnswer());
      await this.describedSignal('answer', pc, generation); return;
    }
    if (generation !== this.generation || !this.pc) return;
    if (message.type === 'answer' && this.room.role === 'host') {
      await this.pc.setRemoteDescription(message.data);
      for (const candidate of this.pendingIce.splice(0)) await this.applyRemoteCandidate(this.pc,candidate);
    } else if (message.type === 'ice') {
      this.remoteCandidates++;
      this.recordCandidate('remote',message.data);this.emitIceDiagnostics(this.pc);
      if (this.pc.remoteDescription) await this.applyRemoteCandidate(this.pc,message.data); else this.pendingIce.push(message.data);
    }
  }
  end(reason) { if (this.abort.signal.aborted) return; this.dispose(); this.hooks.onEnded?.(reason); }
  dispose() {
    this.abort.abort(); clearInterval(this.tick); clearTimeout(this.retryTimer); clearTimeout(this.disconnectTimer);
    const ws = this.ws; this.ws = null; ws?.close();
    const pc = this.pc; this.pc = null; pc?.close(); this.channel = null;
  }
}
