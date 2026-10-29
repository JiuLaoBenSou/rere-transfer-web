// Acknowledged/written payload bytes, not queued bytes or network link speed.
export class TransferRate {
  constructor(offset = 0, now = () => performance.now()) {
    this.now = now; this.started = now(); this.offset = offset; this.bytes = 0;
    this.samples = [{ time: this.started, bytes: 0 }]; this.ended = null;
  }
  update(offset) {
    const time = this.now();
    this.bytes += Math.max(0, offset - this.offset); this.offset = offset;
    this.samples.push({ time, bytes: this.bytes }); this.trim(time);
  }
  rebase(offset) {
    // A resumed offset may include a block whose ACK was lost. Do not count it twice.
    this.offset = offset; this.samples = [{ time: this.now(), bytes: this.bytes }];
  }
  trim(time) {
    while (this.samples.length > 1 && this.samples[1].time <= time - 2000) this.samples.shift();
  }
  finish() { this.ended ??= this.now(); return this.snapshot(); }
  snapshot() {
    const time = this.ended ?? this.now(); this.trim(time);
    const first = this.samples[0], last = this.samples.at(-1);
    const elapsed = Math.max(0, time - this.started) / 1000;
    const window = Math.max(0, time - first.time) / 1000;
    return { elapsed, average: elapsed > 0 ? this.bytes / elapsed : 0,
      rate: time - last.time >= 2000 ? 0 : window > 0 ? (this.bytes - first.bytes) / window : 0 };
  }
}
export const formatRate = bytesPerSecond => (Math.max(0, bytesPerSecond) / 1e6).toFixed(2) + ' MB/s';
