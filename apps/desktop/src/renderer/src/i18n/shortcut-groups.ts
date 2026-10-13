import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ShortcutAction } from "../../../shared/shortcuts";

/** The sections of the keyboard shortcuts list, in the order it shows them. */
export const SHORTCUT_GROUPS = [
  "triage",
  "navigation",
  "reading",
  "compose",
  "formatting",
  "window",
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export const SHORTCUT_GROUP_NAMES: Record<ShortcutGroup, MessageDescriptor> = {
  triage: msg({
    message: "Triage",
    comment: "Keyboard shortcuts section: archive, delete, mark read, star and similar actions.",
  }),
  navigation: msg({
    message: "Navigation",
    comment: "Keyboard shortcuts section: moving between messages, mailboxes and panes.",
  }),
  reading: msg({
    message: "Reading",
    comment: "Keyboard shortcuts section: actions on the open message, such as text size.",
  }),
  compose: msg({
    message: "Compose",
    comment: "Keyboard shortcuts section: writing, replying to and sending messages.",
  }),
  formatting: msg({
    message: "Formatting",
    comment: "Keyboard shortcuts section: text styles in the message editor.",
  }),
  window: msg({
    message: "Window",
    comment: "Keyboard shortcuts section: windows, tabs, panes and app settings.",
  }),
};

/** Every action's section. A Record, so a new action without a section fails to type-check. */
export const SHORTCUT_GROUP: Record<ShortcutAction, ShortcutGroup> = {
  archive: "triage",
  trash: "triage",
  spam: "triage",
  read: "triage",
  markRead: "triage",
  markUnread: "triage",
  star: "triage",
  important: "triage",
  label: "triage",
  move: "triage",
  inbox: "triage",
  select: "triage",
  undo: "triage",
  sync: "window",

  next: "navigation",
  previous: "navigation",
  openThread: "navigation",
  search: "navigation",
  goToFolder: "navigation",
  filterUnread: "navigation",
  jumpSelection: "navigation",
  findNext: "navigation",
  findPrevious: "navigation",
  findSelection: "navigation",

  expandAll: "reading",
  collapseAll: "reading",
  zoomIn: "reading",
  zoomOut: "reading",
  zoomReset: "reading",
  showOriginal: "reading",
  loadRemoteContent: "reading",
  toggleMessageBackground: "reading",
  saveMessage: "reading",
  searchSender: "reading",
  shareMessageLink: "reading",
  shareThreadLink: "reading",
  shareWebLink: "reading",
  openMessageWeb: "reading",
  print: "reading",
  assistant: "reading",

  compose: "compose",
  reply: "compose",
  replyAll: "compose",
  forward: "compose",
  forwardAttachment: "compose",
  send: "compose",
  sendArchive: "compose",
  attach: "compose",
  saveDraft: "compose",
  showCc: "compose",
  closeCompose: "compose",
  templates: "compose",
  composeAssistant: "compose",
  pasteMatchStyle: "compose",
  pasteQuotation: "compose",

  bold: "formatting",
  italic: "formatting",
  underline: "formatting",
  strikethrough: "formatting",
  link: "formatting",
  superscript: "formatting",
  subscript: "formatting",
  alignLeft: "formatting",
  alignCenter: "formatting",
  alignRight: "formatting",
  alignJustify: "formatting",
  directionLtr: "formatting",
  directionRtl: "formatting",
  directionAuto: "formatting",
  bulletList: "formatting",
  numberList: "formatting",
  dashList: "formatting",
  inlineCode: "formatting",
  blockCode: "formatting",
  indentParagraph: "formatting",
  outdentParagraph: "formatting",
  indentList: "formatting",
  outdentList: "formatting",
  quoteIncrease: "formatting",
  quoteDecrease: "formatting",
  copyStyle: "formatting",
  pasteStyle: "formatting",
  clearFormatting: "formatting",
  toggleFormatBar: "formatting",
  fontSizeIncrease: "formatting",
  fontSizeDecrease: "formatting",

  nextWindow: "window",
  previousWindow: "window",
  nextTab: "window",
  previousTab: "window",
  focusMainWindow: "window",
  newWindow: "window",
  toggleReadingPane: "window",
  toggleSidebar: "window",
  toggleToolbar: "window",
  toggleReader: "window",
  toggleFullScreen: "window",
  settings: "window",
  help: "window",
};

/** True when `text` contains every word of the filter, ignoring case. */
export function matchesShortcutFilter(filter: string, ...texts: readonly string[]): boolean {
  const words = filter.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = texts.join(" ").toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
