import { expect, it } from "vitest";
import { shortcutAction, type KeyEvent, type ShortcutSet } from "../../../../shared/shortcuts";
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

it("find previous and selection use the central keymap in each set", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(readerFindAction(set, key("g", { altKey: true }), true)).toBe("previous");
    expect(readerFindAction(set, key("g", { altKey: true }), false)).toBeNull();
    expect(readerFindAction(set, key("e"), false)).toBe("selection");
    expect(readerFindAction(set, key("j", { altKey: true }), false)).toBe("jump");
    expect(readerFindAction(set, key("e", { altKey: true }), false)).toBeNull();
  }
});

it("next and previous step through search hits while find is closed", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(readerFindAction(set, key("g"), false, true)).toBe("next");
    expect(readerFindAction(set, key("g", { altKey: true }), false, true)).toBe("previous");
    expect(readerFindAction(set, key("G", { shiftKey: true }), false, true)).toBeNull();
  }
});
