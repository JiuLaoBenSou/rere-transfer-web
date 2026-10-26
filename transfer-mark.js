// Codex / 2026-10-25. Decorative endpoints + four-weight field. No idle animation.
export function createTransferMark(canvas) {
  const context = canvas?.getContext('2d');
  if (!context) return { refresh() {}, setConnected() {}, setProgress() {}, reset() {} };
  let scheduled = false, connected = false, fraction = null, direction = 'send';
  const widths = [.75, 1.5, 2.3, 3.2];
  function paint() {
    scheduled = false;
    if (document.hidden) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    context.setTransform(dpr * rect.width / 272, 0, 0, dpr * rect.height / 112, 0, 0);
    context.clearRect(0, 0, 272, 112);
    context.strokeStyle = connected ? '#d18c52' : '#97613e'; context.lineWidth = 1.2;
    context.beginPath(); context.roundRect(6, 28, 42, 57, 8); context.roundRect(224, 22, 42, 68, 8); context.stroke();
    const activePosition = fraction === null ? null : direction === 'send' ? fraction : 1 - fraction;
    for (let weight = 0; weight < 4; weight++) {
      context.beginPath(); context.lineWidth = widths[weight]; context.lineCap = 'round';
      context.strokeStyle = ['#68452f', '#94623f', '#c8884b', '#e5a35b'][weight];
      for (let col = 0; col < 19; col++) {
        const x = 63 + col * 8, pos = col / 18;
        const strength = activePosition === null ? Math.exp(-(((pos - .5) / .27) ** 2)) * .82 : Math.max(0, 1 - Math.abs(pos - activePosition) * 5);
        const bucket = Math.min(3, Math.floor(strength * 4));
        if (bucket !== weight) continue;
        const height = 8 + bucket * 5;
        context.moveTo(x, 56 - height / 2); context.lineTo(x, 56 + height / 2);
      }
      context.stroke();
    }
  }
  function refresh() { if (!scheduled) { scheduled = true; requestAnimationFrame(paint); } }
  const observer = new ResizeObserver(refresh); observer.observe(canvas);
  window.addEventListener('resize', refresh, { passive: true });
  document.addEventListener('visibilitychange', refresh);
  canvas.dataset.mode = 'idle'; refresh();
  return {
    refresh,
    setConnected(value) { connected = value; if (!value) { fraction = null; canvas.dataset.mode = 'idle'; delete canvas.dataset.progress; } refresh(); },
    setProgress(value, flow) { if (!Number.isFinite(value)) return; fraction = Math.max(0, Math.min(1, value)); direction = flow; canvas.dataset.mode = flow; canvas.dataset.progress = String(fraction); refresh(); },
    reset() { fraction = null; canvas.dataset.mode = 'idle'; delete canvas.dataset.progress; refresh(); },
  };
}
