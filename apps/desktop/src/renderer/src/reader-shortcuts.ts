import { matchesShortcut, type ShortcutSet } from "../../shared/shortcuts";

type Key = Parameters<typeof matchesShortcut>[2];
/** Shift-F forwards; Shift-G opens the message on the web. Previous find uses Shift-Enter. */
export function readerFindAction(set: ShortcutSet, event: Key, finding: boolean) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return null;
  if (matchesShortcut(set, "forward", event) || matchesShortcut(set, "openMessageWeb", event))
    return null;
  const key = event.key.toLowerCase();
  return key === "f" ? "find" : key === "g" && finding ? "next" : null;
}
