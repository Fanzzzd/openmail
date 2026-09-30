import { describe, expect, it } from "vitest";

import {
  KEYMAP,
  matchesShortcut,
  selectionShortcut,
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
  it("holding reader shortcuts never queues additional dialogs, tabs or sender searches", () => {
    const strokes = [
      event("s", { metaKey: true, altKey: true }),
      event("g", { metaKey: true, shiftKey: true }),
      event("k", { metaKey: true, shiftKey: true }),
    ];
    for (const set of ["mimestream", "apple", "gmail"] as const) {
      for (const stroke of strokes) {
        const action = shortcutAction(set, stroke);
        expect(action).not.toBeNull();
        for (let repeat = 0; repeat < 20; repeat++) {
          expect(shortcutAction(set, { ...stroke, repeat: true })).toBeNull();
        }
        expect(shortcutAction(set, { ...stroke, repeat: false })).toBe(action);
      }
      expect(shortcutAction(set, event("ArrowDown", { repeat: true }))).toBe("next");
    }
  });
  it("offers reading actions in every set without stealing typing shortcuts", () => {
    for (const set of ["mimestream", "apple", "gmail"] as const) {
      for (const [key, action] of [
        ["e", "expandAll"],
        ["c", "collapseAll"],
        ["s", "saveMessage"],
      ] as const) {
        const stroke = event(key, { metaKey: true, altKey: true });
        expect(shortcutAction(set, stroke)).toBe(action);
        expect(shortcutAction(set, stroke, true)).toBeNull();
      }
      expect(shortcutAction(set, event("k", { metaKey: true, shiftKey: true }))).toBe(
        "searchSender",
      );
      expect(shortcutAction(set, event("g", { metaKey: true, shiftKey: true }))).toBe(
        "openMessageWeb",
      );
    }
  });
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

it("selection keys preserve archive, profile and typing modifier combinations", () => {
  expect(selectionShortcut(event("a", { metaKey: true }))).toBe("all");
  expect(selectionShortcut(event("a", { ctrlKey: true }))).toBe("all");
  expect(selectionShortcut(event("a", { metaKey: true, ctrlKey: true }))).toBeNull();
  expect(shortcutAction("mimestream", event("a", { metaKey: true, ctrlKey: true }))).toBe(
    "archive",
  );
  expect(selectionShortcut(event("ArrowDown", { shiftKey: true }))).toBe("extendNext");
  expect(selectionShortcut(event("ArrowUp", { shiftKey: true }))).toBe("extendPrevious");
  expect(selectionShortcut(event("ArrowUp", { shiftKey: true, altKey: true }))).toBeNull();
});
