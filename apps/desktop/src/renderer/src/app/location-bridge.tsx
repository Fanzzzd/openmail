import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";
import { mailHref } from "../../../shared/routes";
import { hrefOf, locationAtom, syncLocationAtom } from "../state/location";
import { useRunMail, withMail } from "../state/mail";

/**
 * Copies every history change into `locationAtom`. History notifies on push,
 * replace, Back and Forward and on redirects, synchronously, so the atoms
 * never lag a navigation the way a wait for the router's onResolved would.
 * The window's own writes arrive with the href the atoms already hold, so
 * only Back, Forward and redirects change anything here.
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
