import { expect, it } from "vitest";
import { shortcutAction, type KeyEvent, type ShortcutSet } from "../../shared/shortcuts";
import { readerFindAction } from "./reader-shortcuts";

const key = (key: string, patch: Partial<KeyEvent> = {}): KeyEvent => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});

for (const set of ["mimestream", "apple", "gmail"] satisfies ShortcutSet[]) {
  it(`${set}: find leaves shifted F/G, forward attachments and web shortcuts to the keymap`, () => {
    expect(readerFindAction(set, key("f"), false)).toBe("find");
    expect(readerFindAction(set, key("g"), true)).toBe("next");
    expect(readerFindAction(set, key("g"), false)).toBeNull();
    const forward = key("F", { shiftKey: true });
    const web = key("G", { shiftKey: true });
    expect(readerFindAction(set, forward, true)).toBeNull();
    expect(readerFindAction(set, web, true)).toBeNull();
    expect(shortcutAction(set, web)).toBe("openMessageWeb");
    if (set !== "gmail") expect(shortcutAction(set, forward)).toBe("forward");
    expect(readerFindAction(set, key("F", { shiftKey: true, altKey: true }), true)).toBeNull();
    expect(readerFindAction(set, key("f", { altKey: true }), true)).toBeNull();
  });
}
