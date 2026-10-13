import { Schema } from "effect";
import { KEYMAP, type ShortcutAction, type ShortcutSet } from "./shortcuts";

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
]);
export type NativeAction = typeof NativeAction.Type;
export const NativeMenuState = Schema.Struct({
  selected: Schema.Boolean,
  composing: Schema.Boolean,
  gmail: Schema.Boolean,
  web: Schema.optionalKey(Schema.Boolean),
  mailbox: Schema.optionalKey(Schema.Boolean),
});
export type NativeMenuState = typeof NativeMenuState.Type;
export const NO_MENU_SELECTION: NativeMenuState = {
  selected: false,
  composing: false,
  gmail: false,
};
export const NATIVE_MENUS = [
  {
    name: "message",
    actions: [
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
  { name: "mailbox", actions: ["sync", "goToFolder", "filterUnread", "search"] },
  {
    name: "format",
    actions: [
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

      "bold",
      "italic",
      "underline",
      "link",
      "strikethrough",
      "pasteMatchStyle",
      "pasteQuotation",
    ],
  },
] satisfies readonly { name: string; actions: readonly NativeAction[] }[];
export function nativeActionUsesEditor(action: NativeAction) {
  return (
    NATIVE_MENUS[2]?.actions.some((a) => a === action) ||
    ["send", "sendArchive", "saveDraft", "templates", "showCc"].includes(action)
  );
}
export function nativeActionEnabled(action: NativeAction, state: NativeMenuState) {
  if (nativeActionUsesEditor(action)) return state.composing;
  if (NATIVE_MENUS[1]?.actions.some((a) => a === action))
    return !state.composing && state.mailbox !== false;
  return (
    state.selected &&
    !state.composing &&
    (action !== "important" || state.gmail) &&
    (action !== "shareWebLink" || state.web === true)
  );
}
/** A Format menu action without a key reaches the focused compose body as this event. */
export const EDITOR_ACTION_EVENT = "openmail:editor-action";
/** Dispatch through existing handlers, including Composer and Reader, using the selected keymap. */
export function nativeActionStroke(set: ShortcutSet, action: ShortcutAction) {
  return KEYMAP[set][action][0];
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
