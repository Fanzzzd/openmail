import { matchesShortcut, type ShortcutSet } from "../../shared/shortcuts";

type Key = Parameters<typeof matchesShortcut>[2];
/** Cmd-Shift-G remains Open on Web; previous find uses Cmd-Option-G. */
export function readerFindAction(set: ShortcutSet, event: Key, finding: boolean) {
  if (matchesShortcut(set, "jumpSelection", event)) return "jump";
  if (matchesShortcut(set, "findSelection", event)) return "selection";
  if (finding && matchesShortcut(set, "findPrevious", event)) return "previous";
  if ((event.metaKey || event.ctrlKey) && !event.altKey && matchesShortcut(set, "search", event))
    return "find";
  return finding && matchesShortcut(set, "findNext", event) ? "next" : null;
}
