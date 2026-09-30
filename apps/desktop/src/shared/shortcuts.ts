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
  closeCompose: [key("Escape")],
  zoomIn: [cmd("+"), cmd("=")],
  zoomOut: [cmd("-")],
  zoomReset: [cmd("0")],
};
const native = {
  ...common,
  compose: [cmd("n")],
  reply: [cmd("r")],
  replyAll: [shiftCmd("r")],
  forward: [shiftCmd("f")],
  forwardAttachment: [cmd("f", { alt: true, shift: true })],
  archive: [controlCmd("a")],
  trash: [cmd("Backspace")],
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
    trash: [key("#"), key("Backspace")],
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
  },
} satisfies Record<ShortcutSet, Record<keyof typeof native, readonly KeyStroke[]>>;
export type ShortcutAction = keyof typeof native;
export interface KeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

function matches(stroke: KeyStroke, event: KeyEvent): boolean {
  if (!stroke.cmd && event.metaKey) return false;
  const primary = stroke.cmd ? event.metaKey || (event.ctrlKey && !stroke.control) : false;
  if (Boolean(stroke.cmd) !== primary || Boolean(stroke.alt) !== event.altKey) return false;
  if (stroke.control ? !event.ctrlKey : event.metaKey && event.ctrlKey) return false;
  if (!stroke.cmd && event.ctrlKey !== Boolean(stroke.control)) return false;
  // Symbols and uppercase letters already encode Shift in KeyboardEvent.key.
  const literalShift =
    stroke.key.length === 1 &&
    (stroke.key !== stroke.key.toLowerCase() || /[?!#+]/.test(stroke.key));
  if (!literalShift && Boolean(stroke.shift) !== event.shiftKey) return false;
  return literalShift
    ? event.key === stroke.key
    : event.key.toLowerCase() === stroke.key.toLowerCase();
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
    if (!isShortcutAction(action)) continue;
    if (typing && !["compose", "newWindow", "settings", "search"].includes(action)) continue;
    if (KEYMAP[set][action].some((stroke) => (!typing || stroke.cmd) && matches(stroke, event)))
      return action;
  }
  return null;
}
export const isShortcutAction = (value: string): value is ShortcutAction =>
  Object.hasOwn(native, value);
export function shortcutText(set: ShortcutSet, action: ShortcutAction): string {
  return KEYMAP[set][action]
    .map((stroke) => {
      const symbol =
        { Enter: "↩", Backspace: "⌫", ArrowDown: "↓", ArrowUp: "↑", Escape: "Esc" }[stroke.key] ??
        stroke.key.toUpperCase();
      return `${stroke.control ? "⌃" : ""}${stroke.alt ? "⌥" : ""}${stroke.shift ? "⇧" : ""}${stroke.cmd ? "⌘" : ""}${stroke.key === "F" ? "⇧F" : symbol}`;
    })
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

/** All sets use ⌃⌘1…9 for profiles; retain the earlier ⌃1 overview / ⌃2 all mapping. */
export function spaceShortcut(
  event: KeyEvent,
): { kind: "profile"; index: number } | { kind: "overview" } | { kind: "all" } | null {
  if (!event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null;
  const index = Number(event.key) - 1;
  return event.metaKey
    ? { kind: "profile", index }
    : index === 0
      ? { kind: "overview" }
      : index === 1
        ? { kind: "all" }
        : { kind: "profile", index: index - 2 };
}
