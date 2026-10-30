import {t} from './i18n.js?v=usage2';
// Codex / 2026-10-25. Ephemeral receiver storage. No server file payloads.
import { randomId } from './id.js?v=usage2';
export const MEMORY_FILE = 32 * 1024 * 1024;
export const MEMORY_INBOX = 64 * 1024 * 1024;
export const DISK_FILE = 2 * 1024 * 1024 * 1024;
const DISK_INBOX = 4 * 1024 * 1024 * 1024, ROOT = 'rere-transfer-temp-v2';
export class ReceiverStore {
  constructor({ memoryOnly = false, navigator: nav = globalThis.navigator } = {}) {
    this.nav = nav; this.mode = 'memory'; this.entries = new Map(); this.retained = 0; this.disposed = false;
    this.ready = this.initialize(memoryOnly);
  }
  get maxFile() { return this.mode === 'disk' ? DISK_FILE : MEMORY_FILE; }
  get maxInbox() { return this.mode === 'disk' ? DISK_INBOX : MEMORY_INBOX; }
  async initialize(memoryOnly) {
    if (memoryOnly || !this.nav?.storage?.getDirectory || !this.nav?.locks?.request) return this;
    try {
      const origin = await this.nav.storage.getDirectory();
      this.root = await origin.getDirectoryHandle(ROOT, { create: true });
      // Only our own namespace is swept. Live tabs hold a separate lock for each directory.
      for await (const [name, handle] of this.root.entries()) {
        if (handle.kind !== 'directory' || !/^page-[a-f0-9-]{36}$/.test(name)) continue;
        await this.nav.locks.request(`${ROOT}:${name}`, { ifAvailable: true }, async lock => {
          if (lock) await this.root.removeEntry(name, { recursive: true }).catch(() => {});
        });
      }
      this.name = `page-${randomId()}`;
      await new Promise((resolve, reject) => {
        this.lockTask = this.nav.locks.request(`${ROOT}:${this.name}`, async () => {
          await new Promise(unlock => { this.unlock = unlock; resolve(); });
        }).catch(reject);
      });
      this.directory = await this.root.getDirectoryHandle(this.name, { create: true });
      if (this.disposed) { await this.root.removeEntry(this.name, { recursive: true }).catch(() => {}); this.unlock?.(); return this; }
      this.mode = 'disk';
    } catch { this.unlock?.(); this.mode = 'memory'; }
    return this;
  }
  open(meta) {
    const next = (this.openChain || Promise.resolve()).then(() => this.openEntry(meta));
    this.openChain = next.catch(() => {}); return next;
  }
  async openEntry(meta) {
    await this.ready;
    if (this.disposed) throw new Error(t('接收页面已结束。'));
    const max = meta.kind === 'text' ? 65536 : this.maxFile;
    if (meta.size > max || this.retained + meta.size > this.maxInbox || this.entries.size >= 20) throw new Error(t('对方接收区容量不足，请清空收件箱或选择较小文件。'));
    let fileHandle, writer;
    const disk = this.mode === 'disk' && meta.kind === 'file';
    const name = `${randomId()}.part`;
    if (disk) {
      const estimate = await this.nav.storage.estimate?.();
      if (estimate && estimate.quota - estimate.usage < meta.size + 1024 * 1024) throw new Error(t('此设备临时存储空间不足，请先清理空间。'));
      try { fileHandle = await this.directory.getFileHandle(name, { create: true }); writer = await fileHandle.createWritable(); }
      catch { await this.directory.removeEntry(name).catch(() => {}); throw new Error(t('无法创建临时接收文件，请检查浏览器存储空间。')); }
    }
    const parts = []; let offset = 0, finished = false, released = false, closing = false, releasing = null;
    const entry = {
      mode: disk ? 'disk' : 'memory',
      write: async bytes => {
        if (closing || released || finished || offset + bytes.length > meta.size) throw new Error(t('接收文件大小异常。'));
        try { if (disk) await writer.write(bytes); else parts.push(bytes.slice()); }
        catch { throw new Error(t('临时接收写入失败，可能是磁盘或浏览器空间不足。')); }
        offset += bytes.length;
      },
      finish: async () => {
        if (released || offset !== meta.size) throw new Error(t('接收文件不完整。'));
        if (disk) { await writer.close(); writer = null; }
        finished = true;
        return disk ? fileHandle.getFile() : new Blob(parts, { type: 'application/octet-stream' });
      },
      release: () => {
        if (released) return Promise.resolve();
        if (releasing) return releasing;
        closing = true;
        releasing = (async () => {
          if (writer) { await writer.abort().catch(() => {}); writer = null; }
          if (disk) {
            try { await this.directory.removeEntry(name); }
            catch (error) { if (error.name !== 'NotFoundError') throw new Error(t('临时文件清理失败，请再次清空收件箱。')); }
          }
          released = true; parts.length = 0;
          this.retained -= meta.size; this.entries.delete(meta.id);
        })().finally(() => { releasing = null; });
        return releasing;
      },
    };
    this.entries.set(meta.id, entry); this.retained += meta.size;
    return entry;
  }
  async clear() { for (const item of [...this.entries.values()]) await item.release(); }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true; await this.ready; await this.clear();
    if (this.directory) await this.root.removeEntry(this.name, { recursive: true }).catch(() => {});
    this.unlock?.();
  }
}
