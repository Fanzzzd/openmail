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

const moves = { PUSH: "push", REPLACE: "replace", BACK: "back", FORWARD: "forward" } as const;

/**
 * The router behind `historyAtom`. Replaces (selection, message, search,
 * dialog) collapse into one write once they settle; pushes write at once.
 * Only app routes go through: an absolute URL here would make the router load
 * another document.
 */
export function historyFor(router: AppRouter, settleMs = SETTLE_MS): AppHistory {
  let waiting: string | null = null;
  // The current entry's place relative to where this window started, followed
  // from the history's own notices, so a replace keeps it and Back lowers it.
  let index = 0;
  router.history.subscribe(({ action }) => {
    if (action.type === "PUSH" || action.type === "FORWARD") index += 1;
    else if (action.type === "BACK") index -= 1;
    else if (action.type === "GO") index += action.index;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const write = (href: string, replace: boolean) => {
    if (parseAppHref(href)) void router.navigate({ href, replace });
  };
  const settle = () => {
    clearTimeout(timer);
    const href = waiting;
    waiting = null;
    if (href !== null) write(href, true);
  };
  // Browser history queues writes until a microtask and folds a replace followed by a push
  // into one push. Writing the queue out here keeps the replace on the entry Back returns to,
  // for every caller that pushes or moves through history next. The settle timer needs no
  // such write: nothing follows it in the same tick.
  const flush = () => {
    settle();
    router.history.flush();
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
      timer = setTimeout(settle, settleMs);
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
    index: () => index,
    pushSame: (href) => {
      flush();
      if (parseAppHref(href)) router.history.push(href);
    },
    listen: (listener) =>
      router.history.subscribe(({ action }) =>
        listener(
          action.type === "GO" ? (action.index > 0 ? "forward" : "back") : moves[action.type],
        ),
      ),
  };
}
