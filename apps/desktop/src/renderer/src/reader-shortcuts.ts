import { matchesShortcut, type ShortcutSet } from "../../shared/shortcuts";

type Key = Parameters<typeof matchesShortcut>[2];
/**
 * Cmd-Shift-G remains Open on Web; previous find uses Cmd-Option-G. Next and
 * previous step through find matches, or through search hits when find is closed.
 */
export function readerFindAction(set: ShortcutSet, event: Key, finding: boolean, hits = false) {
  const stepping = finding || hits;
  if (matchesShortcut(set, "jumpSelection", event)) return "jump";
  if (matchesShortcut(set, "findSelection", event)) return "selection";
  if (stepping && matchesShortcut(set, "findPrevious", event)) return "previous";
  if ((event.metaKey || event.ctrlKey) && !event.altKey && matchesShortcut(set, "search", event))
    return "find";
  return stepping && matchesShortcut(set, "findNext", event) ? "next" : null;
}
