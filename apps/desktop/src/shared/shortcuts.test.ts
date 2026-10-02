import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
  KEYMAP,
  isShortcutAction,
  folderShortcut,
  NUMBERED_MAILBOXES,
  paneShortcut,
  matchesShortcut,
  selectionShortcut,
  shortcutAction,
  shortcutText,
  shortcutAccelerator,
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
    expect(shortcutAction("gmail", event("e", { metaKey: true }))).toBe("findSelection");
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

it("Cc expansion uses Cmd-Shift-C in every shortcut set", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(
      matchesShortcut(set, "showCc", {
        key: "C",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe(true);
    expect(
      matchesShortcut(set, "showCc", {
        key: "c",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBe(false);
  }
});

it("folder number keys follow each keymap without claiming Profile, overview/all or typing keys", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    for (const [index, mailbox] of NUMBERED_MAILBOXES.entries()) {
      const digit = String(index + 1);
      const folderKey = event(digit, { metaKey: true, ctrlKey: set === "gmail" });
      const profileKey = event(digit, { metaKey: true, ctrlKey: set !== "gmail" });
      expect(folderShortcut(set, folderKey)).toBe(mailbox);
      expect(spaceShortcut(folderKey, set)).toBeNull();
      expect(spaceShortcut(profileKey, set)).toEqual({ kind: "profile", index });
      expect(folderShortcut(set, profileKey)).toBeNull();
      expect(folderShortcut(set, folderKey, true)).toBeNull();
      expect(folderShortcut(set, { ...folderKey, altKey: true })).toBeNull();
      expect(folderShortcut(set, { ...folderKey, shiftKey: true })).toBeNull();
      expect(folderShortcut(set, { ...folderKey, repeat: true })).toBeNull();
    }
    expect(folderShortcut(set, event("9", { metaKey: true, ctrlKey: set === "gmail" }))).toBeNull();
    expect(spaceShortcut(event("9", { metaKey: true, ctrlKey: set !== "gmail" }), set)).toEqual({
      kind: "profile",
      index: 8,
    });
    expect(spaceShortcut(event("1", { ctrlKey: true }), set)).toEqual({ kind: "overview" });
    expect(spaceShortcut(event("2", { ctrlKey: true }), set)).toEqual({ kind: "all" });
  }
});
it("only unmodified horizontal arrows request a pane move", () => {
  expect(paneShortcut(event("ArrowLeft"))).toBe("left");
  expect(paneShortcut(event("ArrowRight"))).toBe("right");
  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
    expect(paneShortcut(event("ArrowRight", { [modifier]: true }))).toBeNull();
  }
  expect(paneShortcut(event("ArrowDown"))).toBeNull();
});

it("every accelerator is unique and every shortcut leaves typing to the editor", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    const accelerators = new Set<string>();
    for (const action of Object.keys(KEYMAP[set])) {
      if (!isShortcutAction(action)) throw new Error(action);
      const accelerator = shortcutAccelerator(set, action);
      if (accelerator) {
        expect(accelerators.has(accelerator)).toBe(false);
        accelerators.add(accelerator);
      }
      for (const stroke of KEYMAP[set][action]) {
        const shifted =
          stroke.key.length === 1 &&
          (stroke.key !== stroke.key.toLowerCase() || /[?!#+~]/.test(stroke.key));
        const input = event(stroke.key, {
          metaKey: Boolean(stroke.cmd),
          ctrlKey: Boolean(stroke.control),
          altKey: Boolean(stroke.alt),
          shiftKey: Boolean(stroke.shift) || shifted,
        });
        const global =
          [
            "compose",
            "newWindow",
            "settings",
            "search",
            "nextWindow",
            "previousWindow",
            "focusMainWindow",
          ].includes(action) &&
          (stroke.cmd || action === "nextWindow" || action === "previousWindow");
        expect(shortcutAction(set, input, true)).toBe(global ? action : null);
        expect(matchesShortcut(set, action, input)).toBe(true);
        expect(shortcutAction(set, input)).toBe(action);
      }
    }
  }
});
it("keyboard extras are shared by every set without overriding web/forward keys", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(shortcutAction(set, event("v", { metaKey: true, altKey: true, shiftKey: true }))).toBe(
      "pasteMatchStyle",
    );
    expect(shortcutAction(set, event("v", { metaKey: true, altKey: true }))).toBe("pasteQuotation");
    expect(shortcutAction(set, event("g", { metaKey: true, altKey: true }))).toBe("findPrevious");
    expect(shortcutAction(set, event("G", { metaKey: true, shiftKey: true }))).toBe(
      "openMessageWeb",
    );
    expect(shortcutAction(set, event("Delete"))).toBe("trash");
    expect(shortcutAction(set, event("Backspace"))).toBe("trash");
  }
});

it("typing retains application/window accelerators and native edit/close/quit keys", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    for (const [key, modifiers, action] of [
      ["n", {}, "compose"],
      ["n", { shiftKey: true }, "newWindow"],
      [",", {}, "settings"],
      ["f", {}, "search"],
      ["`", {}, "nextWindow"],
      ["~", { shiftKey: true }, "previousWindow"],
      ["0", { altKey: true }, "focusMainWindow"],
    ] as const)
      expect(shortcutAction(set, event(key, { metaKey: true, ...modifiers }), true)).toBe(action);
    for (const key of ["c", "v", "x", "a", "z", "w", "q"])
      expect(shortcutAction(set, event(key, { metaKey: true }), true)).toBeNull();
    expect(shortcutAction(set, event("c"), true)).toBeNull();
  }
});

it("reader source, remote content, background and filter shortcuts exist in every keymap and suppress repeated opens", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    const base = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false };
    assert.strictEqual(shortcutAction(set, { ...base, key: "u" }), "showOriginal");
    assert.strictEqual(
      shortcutAction(set, { ...base, key: "r", shiftKey: true }),
      "loadRemoteContent",
    );
    assert.strictEqual(shortcutAction(set, { ...base, key: "b" }), "toggleMessageBackground");
    assert.strictEqual(shortcutAction(set, { ...base, key: "l" }), "filterUnread");
    assert.strictEqual(shortcutAction(set, { ...base, key: "u", repeat: true }), null);
  }
});
