import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { mailHref, parseAppHref } from "../../../shared/routes";
import { type AppHistory, locationAtom, locationOf, syncLocationAtom } from "../state/location";
import { useRunMail, withMail } from "../state/mail";

type RouterLocation = AnyRouter["history"]["location"];
const hrefOf = (location: RouterLocation) => `${location.pathname}${location.search}`;

/** The location to seed `locationAtom` with before the first render. */
export const initialLocation = (router: AnyRouter) => locationOf(hrefOf(router.history.location));

/**
 * The router behind `historyAtom`. Only app routes go through: an absolute
 * URL here would make the router load another document.
 */
export function historyFor(router: AnyRouter): AppHistory {
  return {
    navigate: (href, replace) => {
      if (parseAppHref(href)) void router.navigate({ href, replace });
    },
    back: () => router.history.back(),
    forward: () => router.history.forward(),
  };
}

/**
 * Copies every history change into `locationAtom`. History notifies on push,
 * replace, Back and Forward and on redirects, synchronously, so the atoms
 * never lag a navigation the way a wait for the router's onResolved would.
 */
export function LocationBridge() {
  const router = useRouter();
  const sync = useAtomSet(syncLocationAtom);
  useEffect(() => {
    sync(hrefOf(router.history.location));
    return router.history.subscribe(({ location }) => sync(hrefOf(location)));
  }, [router, sync]);

  // Main saves the view and open thread for restore; search and dialogs start fresh.
  const { route } = useAtomValue(locationAtom);
  const saved =
    route.kind === "mail"
      ? mailHref(route.view, route.state.thread ? { thread: route.state.thread } : {})
      : null;
  const run = useRunMail();
  useEffect(() => {
    if (saved) run(withMail((call) => call("SetWindowRoute", { href: saved })));
  }, [run, saved]);
  return null;
}
