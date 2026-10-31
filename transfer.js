import {t} from './i18n.js?v=inbox1';
// Codex / 2026-10-25. Protocol v2: bounded blocks, ACK, integrity, same-page resume.
import { createHasher, sha256, hex } from './hash.js?v=inbox1';
import { randomId } from './id.js?v=inbox1';
import { ReceiverStore, DISK_FILE } from './receiver-store.js?v=inbox1';
export { sha256 };
export const MAX_FILE = DISK_FILE, MAX_TEXT = 20000, BLOCK = 256 * 1024;
const CHUNK = 16 * 1024;
const MAX_WINDOW = 4; // At most 1 MiB in flight; larger cold bursts regressed browser tests.
const noop = () => {};
const interrupted = () => Object.assign(new Error(t('连接暂时中断，正在等待恢复…')), { code: 'LINK_INTERRUPTED' });
export class TransferSession {
  constructor(channel, hooks = {}, options = {}) {
    this.hooks = new Proxy(hooks, { get: (object, key) => object[key] || noop });
    this.store = options.store || new ReceiverStore(options); this.ownsStore = !options.store;
    this.waiters = new Map(); this.connectionWaiters = new Set(); this.receipts = new Map(); this.pendingCancels = new Set();
    this.incoming = null; this.outgoing = null; this.channel = null; this.epoch = 0; this.chain = Promise.resolve();
    this.disposed = false; this.confirmTimeout = options.confirmTimeout || 60000;
    this.resumeTimeout = options.resumeTimeout || 60000; this.blockTimeout = options.blockTimeout || 30000;
    this.autoAccept = options.autoAccept === true;
    this.sendWindow = Number.isInteger(options.sendWindow) ? Math.min(MAX_WINDOW, Math.max(1, options.sendWindow)) : MAX_WINDOW;
    this.ready = this.store.ready.then(() => { this.hooks.onLocalCapabilities(this.capabilities()); });
    if (channel) this.attachChannel(channel);
  }
  capabilities() { return { version: 2, mode: this.store.mode, maxFile: this.store.maxFile, maxInbox: this.store.maxInbox, receiveWindow: MAX_WINDOW }; }
  attachChannel(channel) {
    if (this.disposed) return;
    if (this.channel && this.channel !== channel) {
      this.rejectWaiters(null, interrupted());
      if (this.incoming) this.incoming.block = null;
    }
    this.unbind?.(); const epoch = ++this.epoch; this.channel = channel;
    channel.binaryType = 'arraybuffer'; channel.bufferedAmountLowThreshold = 64 * 1024;
    let opened = false;
    const onOpen = async () => {
      if (opened || epoch !== this.epoch) return; opened = true;
      await this.ready; if (epoch !== this.epoch || this.disposed) return;
      for (const id of this.pendingCancels) if (this.tryControl({ type: 'cancel', id })) this.pendingCancels.delete(id);
      this.tryControl({ type: 'hello', ...this.capabilities() });
      for (const waiter of [...this.connectionWaiters]) waiter.resolve();
    };
    const onClose = () => {
      if (epoch !== this.epoch) return;
      this.channel = null; this.rejectWaiters(null, interrupted());
      if (this.incoming) this.incoming.block = null;
      if (this.outgoing || this.incoming?.accepted) this.hooks.onPaused();
    };
    const onMessage = event => {
      this.chain = this.chain.then(async () => {
        if (epoch !== this.epoch || this.disposed) return;
        await this.ready; await this.receive(event.data);
      }).catch(error => { if (error.code !== 'LINK_INTERRUPTED') return this.failIncoming(error.message); });
    };
    channel.addEventListener('open', onOpen); channel.addEventListener('close', onClose); channel.addEventListener('message', onMessage);
    this.unbind = () => { channel.removeEventListener('open', onOpen); channel.removeEventListener('close', onClose); channel.removeEventListener('message', onMessage); };
    if (channel.readyState === 'open') onOpen();
  }
  control(message) {
    if (this.channel?.readyState !== 'open') throw interrupted();
    this.channel.send(JSON.stringify(message));
  }
  tryControl(message) { try { this.control(message); return true; } catch { return false; } }
  notifyCancel(id) {
    if (!this.tryControl({ type: 'cancel', id }) && !this.disposed) {
      this.pendingCancels.add(id); if (this.pendingCancels.size > 20) this.pendingCancels.delete(this.pendingCancels.values().next().value);
    }
  }
  wait(type, id, ms) {
    const key = type + ':' + id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(key); reject(new Error(type === 'accepted' ? t('对方尚未确认，接收请求已超时。') : t('等待对方确认超时，请重试本次内容。'))); }, ms);
      this.waiters.set(key, { resolve, reject, timer });
    });
    promise.catch(noop); return promise;
  }
  resolve(type, message) {
    const key = type + ':' + message.id, waiter = this.waiters.get(key); if (!waiter) return;
    clearTimeout(waiter.timer); this.waiters.delete(key); waiter.resolve(message);
  }
  rejectWaiters(id, error) {
    for (const [key, waiter] of this.waiters) if (!id || key.endsWith(':' + id)) { clearTimeout(waiter.timer); this.waiters.delete(key); waiter.reject(error); }
  }
  assertJob(job) {
    if (this.disposed) throw new Error(t('连接已结束。'));
    if (job.cancelled || this.outgoing !== job) throw new Error(t('已取消发送。'));
  }
  async waitConnected(job) {
    this.assertJob(job);
    if (this.channel?.readyState === 'open') return;
    this.hooks.onSendStatus(t('连接中断，等待恢复后继续…')); this.hooks.onPaused();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.connectionWaiters.delete(waiter); reject(new Error(t('重连等待超时，请重新连接后重试。'))); }, this.resumeTimeout);
      const waiter = { resolve: () => { clearTimeout(timer); this.connectionWaiters.delete(waiter); resolve(); }, reject: error => { clearTimeout(timer); this.connectionWaiters.delete(waiter); reject(error); } };
      this.connectionWaiters.add(waiter);
    });
    this.assertJob(job);
  }
  async drain(job) {
    this.assertJob(job);
    const channel = this.channel;
    if (channel?.readyState !== 'open') throw interrupted();
    if (channel.bufferedAmount <= 256 * 1024) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', closed); job.abort.signal.removeEventListener('abort', cancelled); };
      const low = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(interrupted()); };
      const cancelled = () => { cleanup(); reject(new Error(t('已取消发送。'))); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(t('发送缓冲等待超时。'))); }, this.blockTimeout);
      channel.addEventListener('bufferedamountlow', low, { once: true }); channel.addEventListener('close', closed, { once: true });
      job.abort.signal.addEventListener('abort', cancelled, { once: true });
      if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) low();
    });
  }
  async sendFile(file) {
    if (!Number.isSafeInteger(file.size) || file.size > MAX_FILE) throw new Error(t('单文件超过本版 2 GiB 上限。'));
    return this.send({ kind: 'file', name: file.name.slice(0, 255), size: file.size }, (start, end) => file.slice(start, end).arrayBuffer());
  }
  async sendText(text) {
    if (!text || text.length > MAX_TEXT) throw new Error(t('请输入 1–20,000 个字符。'));
    const bytes = new TextEncoder().encode(text);
    return this.send({ kind: 'text', name: t('文字与代码'), size: bytes.length }, async (start, end) => bytes.slice(start, end).buffer);
  }
  async send(meta, read) {
    if (this.outgoing) throw new Error(t('请等待当前内容发送结束。'));
    const job = { id: randomId(), cancelled: false, abort: new AbortController(), ...meta, offset: 0, attempts: 0 };
    this.outgoing = job;
    try {
      await this.ready; await this.waitConnected(job);
      if (job.kind === 'file' && this.remote && job.size > this.remote.maxFile) throw new Error(t('对方浏览器当前仅支持较小文件，请查看接收上限。'));
      this.hooks.onPrepareStart(); this.hooks.onSendStatus(t('正在准备校验…'));
      const hash = createHasher();
      for (let offset = 0; offset < job.size; offset += BLOCK) {
        this.assertJob(job); const bytes = new Uint8Array(await read(offset, Math.min(offset + BLOCK, job.size)));
        hash.update(bytes); this.hooks.onPrepareProgress(Math.min(offset + BLOCK, job.size), job.size);
      }
      job.hash = hex(hash.digest());
      let complete = false;
      while (!complete) {
        this.assertJob(job); await this.waitConnected(job);
        try {
          const acceptance = this.wait('accepted', job.id, this.confirmTimeout);
          this.control({ type: 'offer', version: 2, id: job.id, kind: job.kind, name: job.name, size: job.size, hash: job.hash, resume: !!job.acceptedOnce });
          this.hooks.onSendStatus(job.attempts ? t('连接已恢复，正在核对续接位置…') : t('等待对方接收…'));
          const accepted = await acceptance;
          if (!accepted.accept) throw new Error(accepted.reason || t('对方拒绝了接收。'));
          job.acceptedOnce = true;
          const offset = accepted.offset;
          if (!Number.isSafeInteger(offset) || offset < job.offset || offset > job.size || (offset !== job.size && offset % BLOCK !== 0)) throw new Error(t('对方返回了无效续接位置。'));
          if (job.attempts) this.hooks.onResumed({ id: job.id, offset });
          job.offset = offset; job.attempts++;
          this.hooks.onSendStart({ id: job.id, offset, size: job.size });
          if (accepted.complete) {
            if (accepted.hash !== job.hash) throw new Error(t('接收回执校验不一致。'));
            complete = true; break;
          }
          await this.sendBlocks(job, read);
          const receipt = this.wait('received', job.id, this.blockTimeout);
          this.control({ type: 'end', id: job.id, hash: job.hash }); this.hooks.onSendStatus(t('已发送，等待对方校验…'));
          const received = await receipt;
          if (received.hash !== job.hash) throw new Error(t('对方校验不一致，请重新发送。'));
          complete = true;
        } catch (error) {
          this.rejectWaiters(job.id, error);
          if (error.code !== 'LINK_INTERRUPTED' || job.cancelled || this.disposed) throw error;
          if (!job.attempts) job.attempts = 1;
          await this.waitConnected(job);
        }
      }
      this.hooks.onSendStatus(t('对方已接收并通过校验。'));
      return { id: job.id, resumed: Math.max(0, job.attempts - 1), hash: job.hash };
    } catch (error) {
      this.notifyCancel(job.id); throw job.cancelled ? new Error(t('已取消发送。')) : error;
    } finally { this.hooks.onSendFinished({ id: job.id }); this.rejectWaiters(job.id, new Error(t('本次发送已结束。'))); if (this.outgoing === job) this.outgoing = null; }
  }
  async sendBlocks(job, read) {
    const window = Math.min(this.sendWindow, this.remote?.receiveWindow || 1);
    const epoch = this.epoch, pending = [];
    let cursor = job.offset, allowed = 1;
    const check = () => { this.assertJob(job); if (epoch !== this.epoch) throw interrupted(); };
    while (cursor < job.size || pending.length) {
      while (cursor < job.size && pending.length < allowed) {
        check();
        const bytes = new Uint8Array(await read(cursor, Math.min(cursor + BLOCK, job.size)));
        check();
        const end = cursor + bytes.length;
        const ack = this.wait('ack@' + end, job.id, this.blockTimeout);
        pending.push({ end, ack });
        this.control({ type: 'block', id: job.id, offset: cursor, length: bytes.length, hash: sha256(bytes) });
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          await this.drain(job); check();
          this.channel.send(bytes.slice(offset, offset + CHUNK).buffer);
        }
        this.control({ type: 'block-end', id: job.id }); cursor = end;
      }
      const next = pending.shift();
      const ack = await next.ack; check();
      if (ack.offset !== next.end) throw new Error(t('分块确认位置不一致。'));
      job.offset = ack.offset; this.hooks.onSendProgress(job.offset, job.size);
      // Warm up each new/resumed transfer; avoid bursting into a cold receiver.
      allowed = Math.min(window, allowed + 1);
    }
  }
  async accept(id, accepted) {
    const item = this.incoming; if (!item || item.id !== id || item.accepted) return;
    clearTimeout(item.timer);
    if (!accepted) { this.tryControl({ type: 'accepted', id, accept: false }); this.incoming = null; return; }
    try {
      item.sink = await this.store.open(item);
      if (this.incoming !== item || this.disposed) { await item.sink.release(); return; }
      item.accepted = true;
      this.hooks.onReceiveStart({ id: item.id, offset: item.offset, size: item.size });
      this.tryControl({ type: 'accepted', id, accept: true, offset: item.offset });
      this.armIncoming(item);
    } catch (error) {
      this.tryControl({ type: 'accepted', id, accept: false, reason: error.message });
      await this.failIncoming(error.message);
    }
  }
  armIncoming(item) {
    clearTimeout(item.timer);
    item.timer = setTimeout(() => { if (this.incoming === item) this.failIncoming(t('接收等待超时，请重新发送。')); }, this.resumeTimeout);
  }
  cancel() {
    const job = this.outgoing; if (!job) return;
    job.cancelled = true; job.abort.abort(); this.rejectWaiters(job.id, new Error(t('已取消发送。')));
    for (const waiter of [...this.connectionWaiters]) waiter.reject(new Error(t('已取消发送。')));
    this.notifyCancel(job.id);
  }
  async failIncoming(reason) {
    const item = this.incoming; if (!item) return;
    this.incoming = null; clearTimeout(item.timer);
    try { await item.sink?.release(); } catch (error) { reason += ' ' + error.message; }
    this.tryControl({ type: 'failed', id: item.id }); this.hooks.onReceiveError(item.id, reason);
  }
  validMeta(msg) {
    return msg.version === 2 && ['file', 'text'].includes(msg.kind) && typeof msg.name === 'string' && msg.name.length <= 255 &&
      Number.isSafeInteger(msg.size) && msg.size >= 0 && msg.size <= (msg.kind === 'text' ? 65536 : MAX_FILE) && /^[a-f0-9]{64}$/.test(msg.hash);
  }
  async receive(raw) {
    if (raw instanceof ArrayBuffer) {
      const item = this.incoming, block = item?.block;
      if (!item?.accepted || !block || raw.byteLength > CHUNK || block.received + raw.byteLength > block.length) throw new Error(t('分块大小或顺序异常，接收已停止。'));
      block.parts.push(raw); block.received += raw.byteLength; this.armIncoming(item); return;
    }
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error(t('收到无法识别的传输消息。'));
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    if (msg.type === 'hello') {
      if (msg.version !== 2 || !Number.isSafeInteger(msg.maxFile) || msg.maxFile < 0 || msg.maxFile > MAX_FILE) return;
      this.remote = { mode: msg.mode === 'disk' ? 'disk' : 'memory', maxFile: msg.maxFile,
        receiveWindow: Number.isInteger(msg.receiveWindow) && msg.receiveWindow > 0 ? Math.min(MAX_WINDOW, msg.receiveWindow) : 1 };
      this.hooks.onRemoteCapabilities(this.remote); return;
    }
    if (typeof msg.id !== 'string' || !/^[a-f0-9-]{36}$/.test(msg.id)) return;
    if (msg.type === 'ack') {
      const type = 'ack@' + msg.offset;
      if (this.waiters.has(type + ':' + msg.id)) this.resolve(type, msg);
      else if ([...this.waiters.keys()].some(key => key.startsWith('ack@') && key.endsWith(':' + msg.id))) this.rejectWaiters(msg.id, new Error(t('分块确认位置不一致。')));
      return;
    }
    if (['accepted', 'received'].includes(msg.type)) { this.resolve(msg.type, msg); return; }
    if (msg.type === 'failed') { this.rejectWaiters(msg.id, new Error(t('对方接收或校验失败，请重试。'))); return; }
    if (msg.type === 'cancel') {
      this.rejectWaiters(msg.id, new Error(t('对方取消了本次传输。')));
      if (this.incoming?.id === msg.id) {
        const item = this.incoming; this.incoming = null; clearTimeout(item.timer); let reason = t('对方取消了发送。');
        try { await item.sink?.release(); } catch (error) { reason += ' ' + error.message; }
        this.hooks.onReceiveError(msg.id, reason);
      }
      return;
    }
    if (msg.type === 'offer') {
      if (!this.validMeta(msg)) { this.tryControl({ type: 'accepted', id: msg.id, accept: false, reason: t('传输版本、大小或校验信息不受支持。') }); return; }
      const receipt = this.receipts.get(msg.id);
      if (receipt && receipt.hash === msg.hash && receipt.size === msg.size) { this.tryControl({ type: 'accepted', id: msg.id, accept: true, complete: true, offset: receipt.size, hash: receipt.hash }); return; }
      if (this.incoming?.id === msg.id) {
        const item = this.incoming;
        if (item.hash !== msg.hash || item.size !== msg.size || item.kind !== msg.kind || item.name !== msg.name) throw new Error(t('续接文件身份不一致。'));
        item.block = null; this.armIncoming(item);
        if (item.accepted) {
          this.hooks.onReceiveStart({ id: item.id, offset: item.offset, size: item.size });
          this.tryControl({ type: 'accepted', id: msg.id, accept: true, offset: item.offset });
        }
        return;
      }
      if (this.incoming || msg.size > (msg.kind === 'text' ? 65536 : this.store.maxFile) || this.store.retained + msg.size > this.store.maxInbox || this.store.entries.size >= 20) {
        this.tryControl({ type: 'accepted', id: msg.id, accept: false, reason: t('对方接收区正忙或已达容量上限，请清空收件箱后重试。') }); return;
      }
      if (msg.resume) { this.tryControl({ type: 'accepted', id: msg.id, accept: false, reason: t('接收端已无本次内容，请重新发送。') }); return; }
      const item = { ...msg, accepted: false, offset: 0, hasher: createHasher(), block: null };
      this.incoming = item;
      item.timer = setTimeout(() => { if (this.incoming === item) { this.incoming = null; this.tryControl({ type: 'accepted', id: item.id, accept: false, reason: t('接收请求已超时。') }); this.hooks.onReceiveError(item.id, t('接收请求已超时。')); } }, this.confirmTimeout);
      this.hooks.onOffer(msg);
      if (this.autoAccept) await this.accept(msg.id, true);
      return;
    }
    const item = this.incoming; if (!item || item.id !== msg.id || !item.accepted) return;
    this.armIncoming(item);
    if (msg.type === 'block') {
      if (item.block || msg.offset !== item.offset || !Number.isSafeInteger(msg.length) || msg.length <= 0 || msg.length > BLOCK || msg.offset + msg.length > item.size || !/^[a-f0-9]{64}$/.test(msg.hash)) throw new Error(t('收到无效的文件分块。'));
      item.block = { offset: msg.offset, length: msg.length, hash: msg.hash, received: 0, parts: [] }; return;
    }
    if (msg.type === 'block-end') {
      const block = item.block;
      if (!block || block.received !== block.length) throw new Error(t('文件分块不完整。'));
      const bytes = new Uint8Array(block.length); let offset = 0;
      for (const part of block.parts) { bytes.set(new Uint8Array(part), offset); offset += part.byteLength; }
      if (sha256(bytes) !== block.hash) throw new Error(t('文件分块校验不一致，内容未保存。'));
      await item.sink.write(bytes);
      if (this.incoming !== item) return;
      item.hasher.update(bytes); item.offset += bytes.length; item.block = null;
      this.hooks.onReceiveProgress(item.id, item.offset, item.size);
      this.tryControl({ type: 'ack', id: item.id, offset: item.offset }); return;
    }
    if (msg.type === 'end') {
      if (item.block || item.offset !== item.size || msg.hash !== item.hash) throw new Error(t('接收文件不完整。'));
      const hash = hex(item.hasher.digest());
      if (hash !== item.hash) throw new Error(t('文件校验不一致，内容未保存。'));
      const blob = await item.sink.finish();
      const text = item.kind === 'text' ? new TextDecoder().decode(await blob.arrayBuffer()) : undefined;
      if (this.incoming !== item || this.disposed) return;
      if (text !== undefined && text.length > MAX_TEXT) throw new Error(t('文字超过接收上限。'));
      clearTimeout(item.timer);
      this.receipts.set(item.id, { size: item.size, hash }); if (this.receipts.size > 20) this.receipts.delete(this.receipts.keys().next().value);
      this.hooks.onReceived({ id: item.id, kind: item.kind, name: item.name, size: item.size, hash, text, blob: item.kind === 'file' ? blob : undefined, storageMode: item.sink.mode, release: item.sink.release });
      this.incoming = null; this.tryControl({ type: 'received', id: item.id, hash });
    }
  }
  async clearInbox() {
    if (this.incoming) throw new Error(t('请先完成或拒绝正在接收的内容。'));
    await this.store.clear(); this.receipts.clear();
  }
  async dispose(reason = t('连接已结束。')) {
    if (this.disposed) return;
    this.disposed = true; this.unbind?.(); this.channel = null;
    this.cancel(); this.rejectWaiters(null, new Error(reason));
    for (const waiter of [...this.connectionWaiters]) waiter.reject(new Error(reason));
    if (this.incoming) { const item = this.incoming; this.incoming = null; clearTimeout(item.timer); try { await item.sink?.release(); } catch (error) { reason += ' ' + error.message; } this.hooks.onReceiveError(item.id, reason); }
    if (this.ownsStore) await this.store.dispose();
  }
}
