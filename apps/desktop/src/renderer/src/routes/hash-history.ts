import { createBrowserHistory, parseHref } from "@tanstack/history";

/**
 * Hash history whose route, search included, lives only after `#`. TanStack's
 * createHashHistory appends the page's own query to the route's search, but
 * this page's query carries `systemLanguages` for i18n, which is not a route
 * param.
 */
export function createAppHashHistory(win: Window = window) {
  return createBrowserHistory({
    window: win,
    parseLocation: () =>
      parseHref(win.location.hash.slice(1) || "/", win.history.state ?? undefined),
    createHref: (href) => `${win.location.pathname}${win.location.search}#${href}`,
  });
}
