import { createRouter, type RouterHistory } from "@tanstack/react-router";
import {
  DEFAULT_VIEW,
  mailHref,
  parseAppHref,
  parseSearch,
  stringifySearch,
} from "../../../shared/routes";
import { type AppHistory, hrefOf, locationOf } from "../state/location";
import { routeTree } from "./routes";

/**
 * One router per window. The app passes hash history, so the page stays
 * index.html and the route lives after `#`; tests pass memory history.
 */
export function createAppRouter(
  history: RouterHistory,
  defaultHref: () => string = () => mailHref(DEFAULT_VIEW),
) {
  return createRouter({
    routeTree,
    history,
    context: { defaultHref },
    // A desktop window: never take the server path, even where tests have no document.
    isServer: false,
    // Plain string params, the same format shared/routes builds in main.
    parseSearch,
    stringifySearch,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}

/** The location to seed `locationAtom` with before the first render. */
export const initialLocation = (router: AppRouter) => locationOf(hrefOf(router.history.location));

/**
 * How long replaces wait for more. Chromium drops history writes past about
 * 200 in 10 seconds, and holding an arrow key in the list would reach that,
 * after which folder switches lose their Back entries.
 */
export const SETTLE_MS = 300;

/**
 * The router behind `historyAtom`. Replaces (selection, message, search,
 * dialog) collapse into one write once they settle; pushes write at once.
 * Only app routes go through: an absolute URL here would make the router load
 * another document.
 */
export function historyFor(router: AppRouter, settleMs = SETTLE_MS): AppHistory {
  let waiting: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (href: string, replace: boolean) => {
    if (parseAppHref(href)) void router.navigate({ href, replace });
  };
  const flush = () => {
    clearTimeout(timer);
    const href = waiting;
    waiting = null;
    if (href !== null) write(href, true);
  };
  return {
    navigate: (href, replace) => {
      if (!replace) {
        flush();
        write(href, false);
        return;
      }
      waiting = href;
      clearTimeout(timer);
      timer = setTimeout(flush, settleMs);
    },
    flush,
    back: () => {
      flush();
      router.history.back();
    },
    forward: () => {
      flush();
      router.history.forward();
    },
  };
}
