import { trimSelection, type Selection } from "../lib/selection";
import { parseAppHref } from "../../../shared/routes";
import type { WindowSelection } from "../../../shared/window-state";
/** The view and message in the window's starting route. */
export function restoredSelection(): WindowSelection | null {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- test DOMs have no location.
  const hash: string | undefined = globalThis.window?.location?.hash;
  const route = hash ? parseAppHref(hash.slice(1)) : null;
  return route?.kind === "mail" ? { ...route.view, messageId: route.state.thread ?? null } : null;
}

export function settleStartupSelection(
  startupId: string | null,
  selection: Selection,
  loaded: boolean,
  visible: ReadonlySet<string>,
) {
  if (!startupId || !loaded) return { startupId, selection };
  return { startupId: null, selection: trimSelection(selection, visible) };
}
