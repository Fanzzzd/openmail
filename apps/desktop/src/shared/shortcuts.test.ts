import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_ONLY_ACTIONS,
  KEYMAP,
  favoriteShortcut,
  isShortcutAction,
  folderShortcut,
  historyShortcut,
  NUMBERED_MAILBOXES,
  paneShortcut,
  matchesShortcut,
  selectionShortcut,
  platformShortcutText,
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
    expect(shortcutText("apple", "nextTab")).toBe("⌥⌘→");
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
  it("has no ambiguous bindings within a set outside the composer", () => {
    for (const set of Object.values(KEYMAP)) {
      const strokes = new Set<string>();
      for (const [action, bindings] of Object.entries(set)) {
        if (!isShortcutAction(action) || COMPOSER_ONLY_ACTIONS.includes(action)) continue;
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
      const composerOnly = COMPOSER_ONLY_ACTIONS.includes(action);
      const accelerator = composerOnly ? undefined : shortcutAccelerator(set, action);
      if (accelerator) {
        expect(accelerators.has(accelerator)).toBe(false);
        accelerators.add(accelerator);
      }
      for (const stroke of KEYMAP[set][action]) {
        const shifted =
          stroke.key.length === 1 &&
          (stroke.key !== stroke.key.toLowerCase() || /[?!#+~{}|]/.test(stroke.key));
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
            "toggleFullScreen",
            "nextTab",
            "previousTab",
          ].includes(action) &&
          (stroke.cmd || action === "nextWindow" || action === "previousWindow");
        expect(matchesShortcut(set, action, input)).toBe(true);
        if (composerOnly) continue;
        expect(shortcutAction(set, input, true)).toBe(global ? action : null);
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

it("⌘[ and ⌘] step through history and leave other bracket chords alone", () => {
  const stroke = (key: string, modifiers: Partial<KeyEvent> = {}): KeyEvent => ({
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });
  expect(historyShortcut(stroke("["))).toBe("back");
  expect(historyShortcut(stroke("]"))).toBe("forward");
  expect(historyShortcut(stroke("[", { metaKey: false, ctrlKey: true }))).toBe("back");
  expect(historyShortcut(stroke("[", { ctrlKey: true }))).toBeNull();
  expect(historyShortcut(stroke("[", { altKey: true }))).toBeNull();
  expect(historyShortcut(stroke("{", { shiftKey: true }))).toBeNull();
  expect(historyShortcut(stroke("[", { metaKey: false }))).toBeNull();
  // Only the composer's indent and outdent share the brackets; the composer handles them first.
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(shortcutAction(set, stroke("["))).toBe("outdentParagraph");
    expect(shortcutAction(set, stroke("]"))).toBe("indentParagraph");
    expect(shortcutAction(set, stroke("["), true)).toBeNull();
  }
});

const strokeEvent = (stroke: (typeof KEYMAP)["gmail"]["next"][number]): KeyEvent => ({
  key: stroke.key,
  metaKey: Boolean(stroke.cmd),
  ctrlKey: Boolean(stroke.control),
  altKey: Boolean(stroke.alt),
  shiftKey:
    Boolean(stroke.shift) ||
    (stroke.key.length === 1 &&
      (stroke.key !== stroke.key.toLowerCase() || /[?!#+~{}|]/.test(stroke.key))),
});

/** The composer body handles these before the window's history keys, which skip typing. */
const composerFormatting = new Set(["indentParagraph", "outdentParagraph"]);

it("no keymap stroke is also a mailbox, profile, favorite, history, pane or selection key", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    for (const [action, strokes] of Object.entries(KEYMAP[set])) {
      for (const stroke of strokes) {
        const input = strokeEvent(stroke);
        expect(folderShortcut(set, input), `${set} ${JSON.stringify(stroke)}`).toBeNull();
        expect(spaceShortcut(input, set), `${set} ${JSON.stringify(stroke)}`).toBeNull();
        expect(favoriteShortcut(input), `${set} ${JSON.stringify(stroke)}`).toBeNull();
        if (!composerFormatting.has(action))
          expect(historyShortcut(input), `${set} ${JSON.stringify(stroke)}`).toBeNull();
        expect(paneShortcut(input), `${set} ${JSON.stringify(stroke)}`).toBeNull();
        expect(selectionShortcut(input), `${set} ${JSON.stringify(stroke)}`).toBeNull();
      }
    }
  }
});

it("the Gmail set has Gmail's undo, select and explicit read and unread keys", () => {
  expect(shortcutAction("gmail", event("z"))).toBe("undo");
  expect(shortcutAction("gmail", event("x"))).toBe("select");
  expect(shortcutAction("gmail", event("I", { shiftKey: true }))).toBe("markRead");
  expect(shortcutAction("gmail", event("U", { shiftKey: true }))).toBe("markUnread");
  // Lowercase u still toggles read, and Shift-I is not Move to Inbox, which needs ⌘.
  expect(shortcutAction("gmail", event("u"))).toBe("read");
  expect(shortcutAction("gmail", event("I", { metaKey: true, shiftKey: true }))).toBe("inbox");
  expect(shortcutText("gmail", "markRead")).toBe("⇧I");
  expect(shortcutText("gmail", "forwardAttachment")).toBe("⇧F");
  for (const set of ["mimestream", "apple"] as const) {
    expect(shortcutAction(set, event("z"))).toBeNull();
    expect(shortcutAction(set, event("x"))).toBeNull();
  }
});

it("⌘J opens the assistant and ⇧⌘J stays Report spam outside the composer", () => {
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    expect(shortcutAction(set, event("j", { metaKey: true }))).toBe("assistant");
    expect(
      matchesShortcut(set, "composeAssistant", event("j", { metaKey: true, shiftKey: true })),
    ).toBe(true);
  }
  expect(shortcutAction("mimestream", event("j", { metaKey: true, shiftKey: true }))).toBe("spam");
  expect(shortcutAction("gmail", event("j", { metaKey: true, shiftKey: true }))).toBeNull();
});

it("AI shortcut labels follow the platform", () => {
  expect(platformShortcutText("mimestream", "assistant", "MacIntel")).toBe("⌘J");
  expect(platformShortcutText("mimestream", "assistant", "Win32")).toBe("Ctrl+J");
  expect(platformShortcutText("mimestream", "composeAssistant", "Linux x86_64")).toBe(
    "Ctrl+Shift+J",
  );
  expect(platformShortcutText("gmail", "markRead", "Win32")).toBe("Shift+I");
});

it("formatting keys follow Mimestream and the macOS text system", () => {
  const cases = [
    ["bold", "⌘B"],
    ["italic", "⌘I"],
    ["underline", "⌘U"],
    ["strikethrough", "⇧⌘X"],
    ["link", "⌘K"],
    ["alignLeft", "⌘{"],
    ["alignCenter", "⌘|"],
    ["alignRight", "⌘}"],
    ["numberList", "⇧⌘7"],
    ["bulletList", "⇧⌘8"],
    ["quoteIncrease", "⌘'"],
    ["quoteDecrease", "⌥⌘'"],
    ["indentParagraph", "⌘]"],
    ["outdentParagraph", "⌘["],
    ["clearFormatting", "⌘\\"],
    ["blockCode", "⇧⌘B"],
  ] as const;
  for (const set of ["mimestream", "apple", "gmail"] as const) {
    for (const [action, text] of cases) expect(shortcutText(set, action)).toBe(text);
    for (const action of [
      "superscript",
      "subscript",
      "dashList",
      "copyStyle",
      "toggleFormatBar",
    ] as const)
      expect(KEYMAP[set][action]).toEqual([]);
  }
});

it("shifted digits and brackets match by physical key when the character differs", () => {
  const set = "mimestream";
  // ⇧⌘7 reports "&" on a US layout.
  expect(
    matchesShortcut(
      set,
      "numberList",
      event("&", { metaKey: true, shiftKey: true, code: "Digit7" }),
    ),
  ).toBe(true);
  expect(
    matchesShortcut(
      set,
      "alignLeft",
      event("[", { metaKey: true, shiftKey: true, code: "BracketLeft" }),
    ),
  ).toBe(true);
  expect(
    matchesShortcut(set, "alignLeft", event("[", { metaKey: true, code: "BracketLeft" })),
  ).toBe(false);
  expect(
    matchesShortcut(
      set,
      "outdentParagraph",
      event("{", { metaKey: true, shiftKey: true, code: "BracketLeft" }),
    ),
  ).toBe(false);
  expect(
    matchesShortcut(
      set,
      "alignCenter",
      event("\\", { metaKey: true, shiftKey: true, code: "Backslash" }),
    ),
  ).toBe(true);
  expect(matchesShortcut(set, "clearFormatting", event("\\", { metaKey: true }))).toBe(true);
  // Without ⌘ the physical key never counts.
  expect(matchesShortcut(set, "numberList", event("&", { shiftKey: true, code: "Digit7" }))).toBe(
    false,
  );
});

it("Snooze has a key in every keymap: Gmail's b, and ⌃⌘Z in the Mac sets", () => {
  expect(shortcutAction("gmail", event("b"))).toBe("snooze");
  expect(shortcutAction("gmail", event("b"), true)).toBeNull();
  for (const set of ["mimestream", "apple"] as const) {
    expect(shortcutAction(set, event("z", { metaKey: true, ctrlKey: true }))).toBe("snooze");
    expect(shortcutAction(set, event("z", { metaKey: true }))).toBe("undo");
    expect(shortcutText(set, "snooze")).toBe("⌃⌘Z");
    expect(shortcutAccelerator(set, "snooze")).toBe("Control+CommandOrControl+z");
  }
  expect(shortcutText("gmail", "snooze")).toBe("B");
});
