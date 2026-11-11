import { useEffect, useRef } from 'react';

// Refresh the active screen after a cached response has been revalidated, a
// mutation, or the visible-page refresh timer. Editors keep their local forms.
export function usePageRefresh(load, prefixes) {
  const current = useRef({ load, prefixes });
  current.current = { load, prefixes };
  useEffect(() => {
    const refresh = (event) => {
      const { load: run, prefixes: paths } = current.current;
      if (!event.detail?.path || paths.some((path) => event.detail.path.startsWith(path))) run();
    };
    window.addEventListener('td:read-updated', refresh);
    window.addEventListener('td:refresh-page', refresh);
    return () => {
      window.removeEventListener('td:read-updated', refresh);
      window.removeEventListener('td:refresh-page', refresh);
    };
  }, []);
}
