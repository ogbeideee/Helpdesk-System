// One visible-page clock. Focus and visibility events commonly arrive together.
export function startPageRefresh({ window, document, refresh, now = Date.now,
  setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval }) {
  let last = -Infinity;
  const run = () => {
    if (document.hidden || now() - last < 1000) return;
    last = now();
    refresh();
  };
  const timer = setInterval(run, 30000);
  window.addEventListener('focus', run);
  document.addEventListener('visibilitychange', run);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', run);
    document.removeEventListener('visibilitychange', run);
  };
}
