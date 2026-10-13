/** One keymap for handlers, native menu accelerators, tooltips and the help sheet. */
import type { Prefs } from "@openmail/core/schema";

export type ShortcutSet = Prefs["shortcutSet"];
export interface KeyStroke {
  key: string;
  cmd?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
}
const key = (value: string): KeyStroke => ({ key: value });
const cmd = (value: string, modifiers: Omit<KeyStroke, "key" | "cmd"> = {}): KeyStroke => ({
  key: value,
  cmd: true,
  ...modifiers,
});
const shiftCmd = (value: string): KeyStroke => cmd(value, { shift: true });
const controlCmd = (value: string): KeyStroke => cmd(value, { control: true });

const common = {
  shareMessageLink: [],
  shareThreadLink: [],
  shareWebLink: [],
  nextTab: [cmd("ArrowRight", { alt: true })],
  previousTab: [cmd("ArrowLeft", { alt: true })],
  nextWindow: [cmd("`"), { key: "Tab", control: true }],
  previousWindow: [cmd("~"), { key: "Tab", control: true, shift: true }],
  focusMainWindow: [cmd("0", { alt: true })],
  toggleReadingPane: [cmd("p", { alt: true })],
  toggleSidebar: [cmd("s", { alt: true, shift: true })],
  toggleToolbar: [cmd("t", { alt: true })],
  toggleReader: [cmd("p", { alt: true, shift: true })],
  toggleFullScreen: [controlCmd("f")],
  jumpSelection: [cmd("j", { alt: true })],
  fontSizeIncrease: [cmd(".", { alt: true })],
  fontSizeDecrease: [cmd(",", { alt: true })],
  findNext: [cmd("g")],
  findPrevious: [cmd("g", { alt: true })],
  findSelection: [cmd("e")],
  // Formatting follows Mimestream and the macOS text system: ⌘{ ⌘| ⌘} align, ⌘[ ⌘] indent,
  // ⌘' ⌥⌘' quote level, ⌘\ removes style and ⇧⌘B is a code block. Lists use Gmail's
  // ⇧⌘7 and ⇧⌘8. ⌘[ and ⌘] are the window's Back and Forward outside the composer.
  // Rare actions stay in the Format menu without a key.
  superscript: [],
  subscript: [],
  alignLeft: [cmd("{")],
  alignCenter: [cmd("|")],
  alignRight: [cmd("}")],
  alignJustify: [],
  directionLtr: [],
  directionRtl: [],
  directionAuto: [],
  bulletList: [shiftCmd("8")],
  numberList: [shiftCmd("7")],
  dashList: [],
  inlineCode: [],
  blockCode: [shiftCmd("b")],
  indentParagraph: [cmd("]")],
  outdentParagraph: [cmd("[")],
  indentList: [],
  outdentList: [],
  quoteIncrease: [cmd("'")],
  quoteDecrease: [cmd("'", { alt: true })],
  copyStyle: [],
  pasteStyle: [],
  clearFormatting: [cmd("\\")],
  toggleFormatBar: [],
  bold: [cmd("b")],
  italic: [cmd("i")],
  underline: [cmd("u")],
  link: [cmd("k")],
  strikethrough: [shiftCmd("x")],
  pasteMatchStyle: [cmd("v", { alt: true, shift: true })],
  pasteQuotation: [cmd("v", { alt: true })],
  newWindow: [shiftCmd("n")],
  settings: [cmd(",")],
  help: [key("?")],
  undo: [cmd("z")],
  print: [cmd("p")],
  goToFolder: [shiftCmd("o")],
  inbox: [shiftCmd("i")],
  filterUnread: [cmd("l", { alt: true })],
  templates: [cmd("/")],
  sendArchive: [shiftCmd("Enter")],
  attach: [shiftCmd("a")],
  saveDraft: [cmd("s")],
  showCc: [shiftCmd("c")],
  closeCompose: [key("Escape")],
  zoomIn: [cmd("+"), cmd("=")],
  zoomOut: [cmd("-")],
  zoomReset: [cmd("0")],
  expandAll: [cmd("e", { alt: true })],
  collapseAll: [cmd("c", { alt: true })],
  showOriginal: [cmd("u", { alt: true })],
  loadRemoteContent: [cmd("r", { alt: true, shift: true })],
  toggleMessageBackground: [cmd("b", { alt: true })],
  saveMessage: [cmd("s", { alt: true })],
  searchSender: [shiftCmd("k")],
  openMessageWeb: [shiftCmd("g")],
  assistant: [cmd("j")],
  composeAssistant: [shiftCmd("j")],
};
const native = {
  ...common,
  compose: [cmd("n")],
  reply: [cmd("r")],
  replyAll: [shiftCmd("r")],
  forward: [shiftCmd("f")],
  forwardAttachment: [cmd("f", { alt: true, shift: true })],
  archive: [controlCmd("a")],
  trash: [cmd("Backspace"), key("Backspace"), key("Delete")],
  spam: [shiftCmd("j")],
  search: [cmd("f", { alt: true }), cmd("f")],
  sync: [controlCmd("r")],
  read: [shiftCmd("u")],
  star: [shiftCmd("l")],
  important: [cmd("i", { alt: true })],
  label: [cmd("l")],
  move: [shiftCmd("m")],
  openThread: [cmd("o")],
  next: [key("ArrowDown")],
  previous: [key("ArrowUp")],
  send: [cmd("Enter")],
  select: [],
  markRead: [],
  markUnread: [],
};
export const KEYMAP = {
  mimestream: native,
  apple: { ...native, send: [shiftCmd("d")] },
  gmail: {
    ...common,
    compose: [key("c"), cmd("n")],
    reply: [key("r")],
    replyAll: [key("a")],
    forward: [key("f")],
    forwardAttachment: [key("F")],
    archive: [key("e")],
    trash: [key("#"), cmd("Backspace"), key("Backspace"), key("Delete")],
    spam: [key("!")],
    search: [key("/"), cmd("f")],
    sync: [cmd("r")],
    read: [key("u"), shiftCmd("u")],
    star: [key("s")],
    important: [key("=")],
    label: [key("l"), cmd("l")],
    move: [key("v"), shiftCmd("m")],
    openThread: [key("o")],
    next: [key("j"), key("ArrowDown")],
    previous: [key("k"), key("ArrowUp")],
    send: [cmd("Enter")],
    undo: [key("z"), cmd("z")],
    select: [key("x")],
    markRead: [key("I")],
    markUnread: [key("U")],
  },
} satisfies Record<ShortcutSet, Record<keyof typeof native, readonly KeyStroke[]>>;
export type ShortcutAction = keyof typeof native;
/**
 * The composer checks these with {@link matchesShortcut} while it is open, so they may reuse a
 * mail key (⇧⌘J is also Report spam). {@link shortcutAction} never returns them.
 */
export const COMPOSER_ONLY_ACTIONS: readonly ShortcutAction[] = ["composeAssistant"];
export interface KeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  /** The physical key. Shifted digits and brackets fall back to it, since ⇧⌘7 may report "&". */
  code?: string;
}

/** Selection gestures shared by all keymaps; extra modifiers keep their original actions. */
export function selectionShortcut(event: KeyEvent): "all" | "extendNext" | "extendPrevious" | null {
  if (event.altKey) return null;
  if (!event.shiftKey && event.metaKey !== event.ctrlKey && event.key.toLowerCase() === "a")
    return "all";
  if (event.shiftKey && !event.metaKey && !event.ctrlKey) {
    if (event.key === "ArrowDown") return "extendNext";
    if (event.key === "ArrowUp") return "extendPrevious";
  }
  return null;
}

/** Symbols whose KeyboardEvent.key already includes Shift. */
const SHIFTED_SYMBOL = /[?!#+~{}|]/;
const isLiteralShift = (key: string) =>
  key.length === 1 && (key !== key.toLowerCase() || SHIFTED_SYMBOL.test(key));
/** Physical keys for strokes whose reported character changes with the layout or with ⌘. */
const STROKE_CODE: Record<string, string> = {
  "{": "BracketLeft",
  "}": "BracketRight",
  "[": "BracketLeft",
  "]": "BracketRight",
  "|": "Backslash",
  "\\": "Backslash",
  "'": "Quote",
};
const strokeCode = (key: string) => (/^[0-9]$/.test(key) ? `Digit${key}` : STROKE_CODE[key]);

function matches(stroke: KeyStroke, event: KeyEvent): boolean {
  if (!stroke.cmd && event.metaKey) return false;
  const primary = stroke.cmd ? event.metaKey || (event.ctrlKey && !stroke.control) : false;
  if (Boolean(stroke.cmd) !== primary || Boolean(stroke.alt) !== event.altKey) return false;
  if (stroke.control ? !event.ctrlKey : event.metaKey && event.ctrlKey) return false;
  if (!stroke.cmd && event.ctrlKey !== Boolean(stroke.control)) return false;
  // Symbols and uppercase letters already encode Shift in KeyboardEvent.key.
  const literalShift = isLiteralShift(stroke.key);
  if (!literalShift && Boolean(stroke.shift) !== event.shiftKey) return false;
  if (
    literalShift ? event.key === stroke.key : event.key.toLowerCase() === stroke.key.toLowerCase()
  )
    return true;
  // Modified strokes only: a plain digit or quote is typing, whatever its physical key.
  const code = stroke.cmd ? strokeCode(stroke.key) : undefined;
  return code !== undefined && event.code === code && (!literalShift || event.shiftKey);
}
export function matchesShortcut(
  set: ShortcutSet,
  action: ShortcutAction,
  event: KeyEvent,
): boolean {
  return KEYMAP[set][action].some((stroke) => matches(stroke, event));
}
export function shortcutAction(
  set: ShortcutSet,
  event: KeyEvent,
  typing = false,
): ShortcutAction | null {
  for (const action of Object.keys(native)) {
    if (!isShortcutAction(action) || COMPOSER_ONLY_ACTIONS.includes(action)) continue;
    // A held reader key must not queue dialogs, browser tabs or searches.
    if (
      event.repeat &&
      [
        "saveMessage",
        "openMessageWeb",
        "searchSender",
        "showOriginal",
        "loadRemoteContent",
        "toggleMessageBackground",
      ].includes(action)
    )
      continue;
    if (
      typing &&
      ![
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
      ].includes(action)
    )
      continue;
    if (
      KEYMAP[set][action].some(
        (stroke) =>
          (!typing || stroke.cmd || action === "nextWindow" || action === "previousWindow") &&
          matches(stroke, event),
      )
    )
      return action;
  }
  return null;
}
export const isShortcutAction = (value: string): value is ShortcutAction =>
  Object.hasOwn(native, value);
export function shortcutText(set: ShortcutSet, action: ShortcutAction): string {
  return KEYMAP[set][action].map(strokeText).join(" / ");
}
/** The first key of an action, for a short hint such as a placeholder. Empty when unbound. */
export function primaryShortcutText(set: ShortcutSet, action: ShortcutAction): string {
  const stroke = KEYMAP[set][action][0];
  return stroke ? strokeText(stroke) : "";
}
function strokeText(stroke: KeyStroke): string {
  const symbol =
    {
      Enter: "↩",
      Backspace: "⌫",
      Delete: "⌦",
      ArrowDown: "↓",
      ArrowUp: "↑",
      ArrowLeft: "←",
      ArrowRight: "→",
      Escape: "Esc",
    }[stroke.key] ?? stroke.key.toUpperCase();
  // An uppercase letter is typed with Shift, so it reads as ⇧ and the letter.
  const shifted = /^[A-Z]$/.test(stroke.key);
  return `${stroke.control ? "⌃" : ""}${stroke.alt ? "⌥" : ""}${stroke.shift || shifted ? "⇧" : ""}${stroke.cmd ? "⌘" : ""}${symbol}`;
}
/** {@link shortcutText} on a Mac; elsewhere written out as Ctrl, Alt and Shift. */
export function platformShortcutText(
  set: ShortcutSet,
  action: ShortcutAction,
  platform: string,
): string {
  if (/Mac|darwin/i.test(platform)) return shortcutText(set, action);
  return KEYMAP[set][action]
    .map((stroke) =>
      [
        ...(stroke.cmd || stroke.control ? ["Ctrl"] : []),
        ...(stroke.alt ? ["Alt"] : []),
        ...(stroke.shift || /^[A-Z]$/.test(stroke.key) ? ["Shift"] : []),
        stroke.key.length === 1 ? stroke.key.toUpperCase() : stroke.key,
      ].join("+"),
    )
    .join(" / ");
}
export function shortcutAccelerator(set: ShortcutSet, action: ShortcutAction): string | undefined {
  const stroke = KEYMAP[set][action].find((s) => s.cmd);
  if (!stroke) return undefined;
  return [
    ...(stroke.control ? ["Control"] : []),
    ...(stroke.alt ? ["Alt"] : []),
    ...(stroke.shift ? ["Shift"] : []),
    "CommandOrControl",
    stroke.key,
  ].join("+");
}

/** Native sets use ⌃⌘1…9 for profiles, Gmail uses ⌘1…9. ⌃1/2 retain overview/all. */
export function spaceShortcut(
  event: KeyEvent,
  set: ShortcutSet = "mimestream",
): { kind: "profile"; index: number } | { kind: "overview" } | { kind: "all" } | null {
  if (event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null;
  if (set === "gmail" && event.metaKey)
    return event.ctrlKey ? null : { kind: "profile", index: Number(event.key) - 1 };
  if (!event.ctrlKey) return null;
  const index = Number(event.key) - 1;
  return event.metaKey
    ? { kind: "profile", index }
    : index === 0
      ? { kind: "overview" }
      : index === 1
        ? { kind: "all" }
        : { kind: "profile", index: index - 2 };
}

export const NUMBERED_MAILBOXES = [
  "inbox",
  "starred",
  "snoozed",
  "drafts",
  "sent",
  "all",
  "trash",
  "spam",
] as const;

/** Gmail swaps folder/profile modifiers; plain Control digits retain overview/all. */
export function folderShortcut(
  set: ShortcutSet,
  event: KeyEvent,
  typing = false,
): (typeof NUMBERED_MAILBOXES)[number] | null {
  if (
    typing ||
    event.repeat ||
    event.altKey ||
    event.shiftKey ||
    !event.metaKey ||
    event.ctrlKey !== (set === "gmail") ||
    !/^[1-8]$/.test(event.key)
  )
    return null;
  return NUMBERED_MAILBOXES[Number(event.key) - 1] ?? null;
}
/** ⌘[ and ⌘] (Ctrl elsewhere) step through the window's history, as in Safari and Mail. */
export function historyShortcut(event: KeyEvent): "back" | "forward" | null {
  if (event.metaKey === event.ctrlKey || event.altKey || event.shiftKey) return null;
  return event.key === "[" ? "back" : event.key === "]" ? "forward" : null;
}

export function paneShortcut(event: KeyEvent): "left" | "right" | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  return event.key === "ArrowLeft" ? "left" : event.key === "ArrowRight" ? "right" : null;
}

/** Favorites keep separate digits from the fixed system mailbox and profile bindings. */
export function favoriteShortcut(event: KeyEvent, typing = false): number | null {
  return !typing &&
    !event.repeat &&
    event.metaKey &&
    event.altKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    /^[1-9]$/.test(event.key)
    ? Number(event.key) - 1
    : null;
}
