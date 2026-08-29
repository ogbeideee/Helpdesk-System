/**
 * The application header owns one title and one subtitle. The shell renders a
 * sensible default for every route; a screen that knows something the route
 * cannot — a live ticket count, the ticket it is showing — overrides it with
 * `usePageHeader`.
 *
 * The override is cleared on unmount, and React runs the leaving screen's
 * cleanup before the arriving screen's effect, so a title never survives a
 * navigation it does not belong to.
 */
import { createContext, useContext, useEffect } from 'react';

export const PageHeaderContext = createContext(null);

export function usePageHeader(title, subtitle) {
  const set = useContext(PageHeaderContext);
  useEffect(() => {
    if (!set) return undefined;
    set({ title: title ?? null, subtitle: subtitle ?? null });
    return () => set(null);
  }, [set, title, subtitle]);
}
