// Renders content/docs/keyboard-shortcuts.mdx from the desktop keymap.
// keyboard-shortcuts.test.ts fails when the page is out of date; `pnpm shortcuts` rewrites it.
import {
  KEYMAP,
  NUMBERED_MAILBOXES,
  isShortcutAction,
  shortcutText,
  type ShortcutAction,
  type ShortcutSet,
} from "../../desktop/src/shared/shortcuts";

const SETS: { id: ShortcutSet; name: string }[] = [
  { id: "mimestream", name: "Mimestream (default)" },
  { id: "gmail", name: "Gmail" },
  { id: "apple", name: "Apple Mail" },
];

export const GROUPS: { title: string; actions: ShortcutAction[] }[] = [
  {
    title: "Mail actions",
    actions: [
      "compose",
      "reply",
      "replyAll",
      "forward",
      "forwardAttachment",
      "archive",
      "trash",
      "spam",
      "read",
      "star",
      "important",
      "label",
      "move",
      "inbox",
      "undo",
      "sync",
      "print",
      "saveMessage",
    ],
  },
  {
    title: "Navigation and search",
    actions: [
      "next",
      "previous",
      "openThread",
      "search",
      "searchSender",
      "goToFolder",
      "filterUnread",
      "jumpSelection",
      "findNext",
      "findPrevious",
      "findSelection",
      "openMessageWeb",
      "shareMessageLink",
      "shareThreadLink",
      "shareWebLink",
    ],
  },
  {
    title: "Reading",
    actions: [
      "expandAll",
      "collapseAll",
      "showOriginal",
      "loadRemoteContent",
      "toggleMessageBackground",
      "fontSizeIncrease",
      "fontSizeDecrease",
      "zoomIn",
      "zoomOut",
      "zoomReset",
    ],
  },
  {
    title: "Windows and layout",
    actions: [
      "newWindow",
      "nextWindow",
      "previousWindow",
      "focusMainWindow",
      "nextTab",
      "previousTab",
      "toggleSidebar",
      "toggleToolbar",
      "toggleReader",
      "toggleReadingPane",
      "toggleFullScreen",
      "settings",
      "help",
    ],
  },
  {
    title: "Compose",
    actions: [
      "send",
      "sendArchive",
      "saveDraft",
      "attach",
      "showCc",
      "templates",
      "closeCompose",
      "pasteMatchStyle",
      "pasteQuotation",
    ],
  },
  {
    title: "Formatting",
    actions: [
      "bold",
      "italic",
      "underline",
      "strikethrough",
      "link",
      "superscript",
      "subscript",
      "inlineCode",
      "blockCode",
      "bulletList",
      "numberList",
      "dashList",
      "indentParagraph",
      "outdentParagraph",
      "indentList",
      "outdentList",
      "quoteIncrease",
      "quoteDecrease",
      "alignLeft",
      "alignCenter",
      "alignRight",
      "alignJustify",
      "directionLtr",
      "directionRtl",
      "directionAuto",
      "copyStyle",
      "pasteStyle",
      "clearFormatting",
      "toggleFormatBar",
    ],
  },
];

const MAILBOX_NAMES: Record<(typeof NUMBERED_MAILBOXES)[number], string> = {
  inbox: "Inbox",
  starred: "Starred",
  snoozed: "Snoozed",
  drafts: "Drafts",
  sent: "Sent",
  all: "All Mail",
  trash: "Trash",
  spam: "Spam",
};

/** English action names from the desktop's Lingui source strings (`action: msg\`Name\``). */
export function parseActionNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of source.matchAll(/^\s*(\w+): msg`([^`]+)`,$/gm)) {
    const [, action, name] = match;
    if (action && name && isShortcutAction(action)) names.set(action, name);
  }
  return names;
}

const cell = (text: string) => text.replaceAll(/[\\`*_{}<>|[\]]/g, (char) => `\\${char}`);

export function renderShortcutsPage(names: Map<string, string>): string {
  const lines = [
    "---",
    "title: Keyboard shortcuts",
    "description: Every keyboard shortcut in OpenMail, for each of the three shortcut sets.",
    "---",
    "",
    "{/* Generated from the desktop keymap by apps/docs/scripts/keyboard-shortcuts.ts. Run `pnpm --filter @openmail/docs shortcuts` to update. */}",
    "",
    "Choose a shortcut set in **Settings → Shortcuts**. Press <kbd>?</kbd> in the app to see the active set. Where an action has more than one shortcut, they are separated by a slash.",
    "",
    "Symbols: ⌘ Command, ⌥ Option, ⌃ Control, ⇧ Shift, ↩ Return, ⌫ Delete, ⌦ Forward Delete.",
  ];
  for (const group of GROUPS) {
    const rows = group.actions.filter((action) =>
      SETS.some((set) => KEYMAP[set.id][action].length > 0),
    );
    if (rows.length === 0) continue;
    lines.push(
      "",
      `## ${group.title}`,
      "",
      `| Action | ${SETS.map((set) => set.name).join(" | ")} |`,
      `| --- | ${SETS.map(() => "---").join(" | ")} |`,
    );
    for (const action of rows) {
      const name = names.get(action);
      if (!name) throw new Error(`No English name for shortcut action ${action}`);
      const keys = SETS.map((set) => cell(shortcutText(set.id, action) || "None"));
      lines.push(`| ${cell(name)} | ${keys.join(" | ")} |`);
    }
  }
  const mailboxes = NUMBERED_MAILBOXES.map(
    (mailbox, index) => `${MAILBOX_NAMES[mailbox]} (${index + 1})`,
  ).join(", ");
  lines.push(
    "",
    "## Numbered shortcuts",
    "",
    `Mailboxes are numbered in this order: ${mailboxes}.`,
    "",
    "| Target | Mimestream and Apple Mail | Gmail |",
    "| --- | --- | --- |",
    "| Mailbox 1 to 8 | ⌘1 to ⌘8 | ⌃⌘1 to ⌃⌘8 |",
    "| Profile 1 to 9 | ⌃⌘1 to ⌃⌘9 | ⌘1 to ⌘9 |",
    "| Favorite 1 to 9 | ⌥⌘1 to ⌥⌘9 | ⌥⌘1 to ⌥⌘9 |",
    "",
  );
  return lines.join("\n");
}
