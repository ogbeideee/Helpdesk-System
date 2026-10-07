const KEY = 'td_chunk_reload_at';
const COOLDOWN_MS = 60000;

export function isChunkLoadError(error) {
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk .+ failed/i.test(error?.message || String(error));
}

// An open browser can still reference the previous deployment's lazy chunks.
// Reload the current URL once to fetch its new entry point. A session guard
// prevents reload loops when the underlying problem is a network failure.
export function installChunkRecovery(browser = window, now = Date.now) {
  const recover = event => {
    if (!isChunkLoadError(event.payload)) return;
    try {
      const last = Number(browser.sessionStorage.getItem(KEY));
      const current = now();
      if (last && current - last < COOLDOWN_MS) return;
      browser.sessionStorage.setItem(KEY, String(current));
    } catch {
      // Without durable session state we cannot safely reload automatically.
      return;
    }
    event.preventDefault();
    browser.location.reload();
  };
  browser.addEventListener('vite:preloadError', recover);
  return () => browser.removeEventListener('vite:preloadError', recover);
}
