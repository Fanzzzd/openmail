import { trimSelection, type Selection } from "./state/selection";
import { Schema } from "effect";
import { WindowSelection } from "../../shared/window-state";
export function restoredSelection(): WindowSelection | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = new URLSearchParams(window.location.search).get("selection");
    return raw ? Schema.decodeUnknownSync(WindowSelection)(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
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
