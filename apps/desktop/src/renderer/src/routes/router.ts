import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { DEFAULT_VIEW, mailHref, parseSearch, stringifySearch } from "../../../shared/routes";
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
