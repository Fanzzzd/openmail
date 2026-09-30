import { describe, expect, it } from "vitest";

import {
  KEYMAP,
  matchesShortcut,
  shortcutAction,
  shortcutText,
  spaceShortcut,
  type KeyEvent,
} from "./shortcuts";

const event = (key: string, patch: Partial<KeyEvent> = {}): KeyEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...patch,
});
describe("central shortcut sets", () => {
  it("switches reply/archive bindings and Apple Mail's send without modifier collisions", () => {
    expect(shortcutAction("mimestream", event("r", { metaKey: true }))).toBe("reply");
    expect(shortcutAction("gmail", event("r", { metaKey: true }))).toBe("sync");
    expect(shortcutAction("gmail", event("r"))).toBe("reply");
    expect(shortcutAction("apple", event("r"))).toBeNull();
    expect(shortcutAction("mimestream", event("a", { metaKey: true, ctrlKey: true }))).toBe(
      "archive",
    );
    expect(shortcutAction("mimestream", event("a", { metaKey: true }))).toBeNull();
    expect(matchesShortcut("apple", "send", event("D", { metaKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(matchesShortcut("apple", "send", event("Enter", { metaKey: true }))).toBe(false);
    expect(shortcutText("apple", "send")).toBe("⇧⌘D");
    expect(shortcutAction("gmail", event("F", { shiftKey: true }))).toBe("forwardAttachment");
  });
  it("leaves typing, content editing shortcuts and extra modifiers alone", () => {
    expect(shortcutAction("gmail", event("e"), true)).toBeNull();
    expect(shortcutAction("gmail", event("?", { shiftKey: true }), true)).toBeNull();
    expect(shortcutAction("gmail", event("Backspace"), true)).toBeNull();
    expect(shortcutAction("mimestream", event("Backspace", { metaKey: true }), true)).toBeNull();
    expect(shortcutAction("gmail", event("e", { altKey: true }))).toBeNull();
    expect(shortcutAction("gmail", event("e", { metaKey: true }))).toBeNull();
    expect(shortcutAction("gmail", event("?", { shiftKey: true }))).toBe("help");
    expect(shortcutAction("mimestream", event("N", { metaKey: true, shiftKey: true }), true)).toBe(
      "newWindow",
    );
    expect(shortcutAction("mimestream", event("r", { ctrlKey: true }))).toBe("reply");
  });
  it("uses control-command digits for profiles and preserves earlier overview/all keys", () => {
    expect(spaceShortcut(event("1", { metaKey: true, ctrlKey: true }))).toEqual({
      kind: "profile",
      index: 0,
    });
    expect(spaceShortcut(event("9", { metaKey: true, ctrlKey: true }))).toEqual({
      kind: "profile",
      index: 8,
    });
    expect(spaceShortcut(event("1", { ctrlKey: true }))).toEqual({ kind: "overview" });
    expect(spaceShortcut(event("2", { ctrlKey: true }))).toEqual({ kind: "all" });
    expect(spaceShortcut(event("1", { metaKey: true }))).toBeNull();
  });
  it("has no ambiguous bindings within a set", () => {
    for (const set of Object.values(KEYMAP)) {
      const strokes = new Set<string>();
      for (const bindings of Object.values(set)) {
        for (const stroke of bindings) {
          const encoded = JSON.stringify(stroke);
          expect(strokes.has(encoded)).toBe(false);
          strokes.add(encoded);
        }
      }
    }
  });
});
