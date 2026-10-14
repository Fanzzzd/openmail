import { providerCapabilities, supportsOp, type Provider } from "@openmail/core/schema";
import { Schema } from "effect";
import {
  KEYMAP,
  NUMBERED_MAILBOXES,
  type KeyStroke,
  type ShortcutAction,
  type ShortcutSet,
} from "./shortcuts";

export const NativeAction = Schema.Literals([
  "superscript",
  "subscript",
  "alignLeft",
  "alignCenter",
  "alignRight",
  "alignJustify",
  "directionLtr",
  "directionRtl",
  "directionAuto",
  "bulletList",
  "numberList",
  "dashList",
  "inlineCode",
  "blockCode",
  "indentParagraph",
  "outdentParagraph",
  "indentList",
  "outdentList",
  "quoteIncrease",
  "quoteDecrease",
  "copyStyle",
  "pasteStyle",
  "clearFormatting",
  "toggleFormatBar",
  "fontSizeIncrease",
  "fontSizeDecrease",

  "reply",
  "replyAll",
  "forward",
  "forwardAttachment",
  "archive",
  "trash",
  "spam",
  "inbox",
  "read",
  "star",
  "important",
  "label",
  "move",
  "snooze",
  "openThread",
  "print",
  "saveMessage",
  "searchSender",
  "openMessageWeb",
  "shareMessageLink",
  "shareThreadLink",
  "shareWebLink",
  "expandAll",
  "collapseAll",
  "sync",
  "goToFolder",
  "filterUnread",
  "search",
  "bold",
  "italic",
  "underline",
  "link",
  "strikethrough",
  "pasteMatchStyle",
  "pasteQuotation",
  "send",
  "sendArchive",
  "saveDraft",
  "templates",
  "showCc",

  "toggleSidebar",
  "toggleReader",
  "toggleReadingPane",
  "toggleToolbar",
  "zoomIn",
  "zoomOut",
  "zoomReset",

  "goInbox",
  "goStarred",
  "goSnoozed",
  "goDrafts",
  "goSent",
  "goAll",
  "goTrash",
  "goSpam",
  "goBack",
  "goForward",
]);
export type NativeAction = typeof NativeAction.Type;
export const NativeMenuState = Schema.Struct({
  selected: Schema.Boolean,
  composing: Schema.Boolean,
  /** The selected account can mark mail important. */
  important: Schema.Boolean,
  web: Schema.optionalKey(Schema.Boolean),
  mailbox: Schema.optionalKey(Schema.Boolean),
});
export type NativeMenuState = typeof NativeMenuState.Type;
export const NO_MENU_SELECTION: NativeMenuState = {
  selected: false,
  composing: false,
  important: false,
};
/** The menu flags that follow the selected account's provider. */
export function providerMenuState(
  provider: Provider | undefined,
): Pick<NativeMenuState, "important" | "web"> {
  if (!provider) return { important: false };
  const caps = providerCapabilities(provider);
  return { important: supportsOp(caps, "important"), web: caps.webLink };
}
/** The Go menu's mailboxes, in the order of their ⌘1…⌘8 keys. */
export const GO_MAILBOXES = {
  goInbox: "inbox",
  goStarred: "starred",
  goSnoozed: "snoozed",
  goDrafts: "drafts",
  goSent: "sent",
  goAll: "all",
  goTrash: "trash",
  goSpam: "spam",
} as const satisfies Record<string, (typeof NUMBERED_MAILBOXES)[number]>;
type GoMailboxAction = keyof typeof GO_MAILBOXES;
export const isGoMailbox = (action: NativeAction): action is GoMailboxAction =>
  Object.hasOwn(GO_MAILBOXES, action);
/** The digit of a Go menu mailbox (1 for Inbox … 8 for Spam), or undefined for other actions. */
export const goMailboxDigit = (action: NativeAction): number | undefined =>
  isGoMailbox(action) ? NUMBERED_MAILBOXES.indexOf(GO_MAILBOXES[action]) + 1 : undefined;

/** A submenu of a native menu, named by its label key. */
export interface NativeSubmenu {
  readonly submenu: "textStyle" | "alignment" | "lists" | "quoteLevel" | "direction";
  readonly actions: readonly NativeAction[];
}
export type NativeMenuEntry = NativeAction | NativeSubmenu | "separator";
export interface NativeMenu {
  readonly name: "view" | "go" | "message" | "mailbox" | "format";
  readonly entries: readonly NativeMenuEntry[];
}

export const NATIVE_MENUS: readonly NativeMenu[] = [
  {
    name: "view",
    entries: [
      "toggleSidebar",
      "toggleReader",
      "toggleReadingPane",
      "toggleToolbar",
      "separator",
      "zoomIn",
      "zoomOut",
      "zoomReset",
    ],
  },
  {
    name: "go",
    entries: [
      "goInbox",
      "goStarred",
      "goSnoozed",
      "goDrafts",
      "goSent",
      "goAll",
      "goTrash",
      "goSpam",
      "separator",
      "goBack",
      "goForward",
    ],
  },
  {
    name: "message",
    entries: [
      "reply",
      "replyAll",
      "forward",
      "forwardAttachment",
      "archive",
      "trash",
      "spam",
      "inbox",
      "read",
      "star",
      "important",
      "label",
      "move",
      "snooze",
      "openThread",
      "print",
      "saveMessage",
      "searchSender",
      "openMessageWeb",
      "shareMessageLink",
      "shareThreadLink",
      "shareWebLink",
      "expandAll",
      "collapseAll",
      "send",
      "sendArchive",
      "saveDraft",
      "templates",
      "showCc",
    ],
  },
  { name: "mailbox", entries: ["sync", "goToFolder", "filterUnread", "search"] },
  {
    name: "format",
    entries: [
      {
        submenu: "textStyle",
        actions: [
          "bold",
          "italic",
          "underline",
          "strikethrough",
          "superscript",
          "subscript",
          "inlineCode",
          "blockCode",
        ],
      },
      { submenu: "alignment", actions: ["alignLeft", "alignCenter", "alignRight", "alignJustify"] },
      {
        submenu: "lists",
        actions: ["bulletList", "numberList", "dashList", "indentList", "outdentList"],
      },
      { submenu: "quoteLevel", actions: ["quoteIncrease", "quoteDecrease"] },
      { submenu: "direction", actions: ["directionLtr", "directionRtl", "directionAuto"] },
      "separator",
      "link",
      "indentParagraph",
      "outdentParagraph",
      "fontSizeIncrease",
      "fontSizeDecrease",
      "separator",
      "copyStyle",
      "pasteStyle",
      "clearFormatting",
      "pasteMatchStyle",
      "pasteQuotation",
      "separator",
      "toggleFormatBar",
    ],
  },
];

/** Every action of a menu, its submenus included, in menu order. */
export const nativeMenuActions = (menu: NativeMenu): NativeAction[] =>
  menu.entries.flatMap((entry) =>
    entry === "separator" ? [] : typeof entry === "string" ? [entry] : entry.actions,
  );
const menuNamed = (name: NativeMenu["name"]) =>
  new Set(NATIVE_MENUS.filter((menu) => menu.name === name).flatMap(nativeMenuActions));
const FORMAT_ACTIONS = menuNamed("format");
const WINDOW_ACTIONS = new Set([...menuNamed("mailbox"), ...menuNamed("go")]);
const VIEW_ACTIONS = menuNamed("view");
const ZOOM_ACTIONS: ReadonlySet<NativeAction> = new Set(["zoomIn", "zoomOut", "zoomReset"]);

export function nativeActionUsesEditor(action: NativeAction) {
  return (
    FORMAT_ACTIONS.has(action) ||
    ["send", "sendArchive", "saveDraft", "templates", "showCc"].includes(action)
  );
}
/** Zoom acts on the reader, so its keys go to the reader's text rather than the window. */
export const nativeActionUsesReader = (action: NativeAction) => ZOOM_ACTIONS.has(action);
export function nativeActionEnabled(action: NativeAction, state: NativeMenuState) {
  if (nativeActionUsesEditor(action)) return state.composing;
  if (ZOOM_ACTIONS.has(action)) return !state.composing;
  // Mailbox, Go and the pane toggles act on the main window's list.
  if (WINDOW_ACTIONS.has(action) || VIEW_ACTIONS.has(action))
    return !state.composing && state.mailbox !== false;
  return (
    state.selected &&
    !state.composing &&
    (action !== "important" || state.important) &&
    (action !== "shareWebLink" || state.web === true)
  );
}
/** A Format menu action without a key reaches the focused compose body as this event. */
export const EDITOR_ACTION_EVENT = "openmail:editor-action";
/**
 * Dispatch through existing handlers, including Composer and Reader, using the selected keymap.
 * Go menu keys are not in the keymap: ⌘1…⌘8 (⌃⌘ with Gmail keys) and ⌘[ ⌘] for Back and Forward.
 */
export function nativeActionStroke(set: ShortcutSet, action: NativeAction): KeyStroke | undefined {
  if (isGoMailbox(action))
    return {
      key: String(goMailboxDigit(action)),
      cmd: true,
      ...(set === "gmail" ? { control: true } : {}),
    };
  if (action === "goBack") return { key: "[", cmd: true };
  if (action === "goForward") return { key: "]", cmd: true };
  return KEYMAP[set][action satisfies ShortcutAction][0];
}

export function nativeShareKind(action: NativeAction) {
  switch (action) {
    case "shareMessageLink":
      return "message";
    case "shareThreadLink":
      return "thread";
    case "shareWebLink":
      return "web";
    default:
      return null;
  }
}
