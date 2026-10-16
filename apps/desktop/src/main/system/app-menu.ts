import type { MenuItemConstructorOptions } from "electron";
import type { DesktopLabels } from "../../shared/desktop-labels";
import {
  goMailboxDigit,
  goSpaceIndex,
  isGoMailbox,
  isGoSpace,
  NATIVE_MENUS,
  nativeActionEnabled,
  nativeActionLabelKey,
  type NativeAction,
  type NativeMenuEntry,
  type NativeMenuState,
} from "../../shared/native-actions";
import { menuAccelerator, shortcutAccelerator, type ShortcutSet } from "../../shared/shortcuts";

/**
 * English labels for the menu items macOS would otherwise title itself, until the renderer sends
 * its Lingui ones. Electron's role defaults are English Title Case; the app writes sentence case.
 */
const DEFAULT_MENU_LABELS: Record<string, string> = {
  view: "View",
  go: "Go",
  textStyle: "Text style",
  alignment: "Alignment",
  lists: "Lists",
  quoteLevel: "Quote level",
  direction: "Direction",
  toggleFullScreen: "Toggle full screen",
  about: "About OpenMail",
  hide: "Hide OpenMail",
  hideOthers: "Hide others",
  unhide: "Show all",
  quit: "Quit OpenMail",
  close: "Close window",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring all to front",
  goInbox: "Inbox",
  goStarred: "Starred",
  goSnoozed: "Snoozed",
  goDrafts: "Drafts",
  goSent: "Sent",
  goAll: "All Mail",
  goTrash: "Trash",
  goSpam: "Spam",
  goOverview: "Overview",
  goAllAccounts: "All accounts",
  goBack: "Previous view",
  goForward: "Next view",
  showSidebar: "Show sidebar",
  hideSidebar: "Hide sidebar",
  showToolbar: "Show toolbar",
  hideToolbar: "Hide toolbar",
  showReader: "Show reading pane",
  hideReader: "Hide reading pane",
};

export interface AppMenuInput {
  readonly platform: NodeJS.Platform;
  readonly labels: DesktopLabels;
  readonly shortcutSet: ShortcutSet;
  readonly undoAvailable: boolean;
  readonly menuState: NativeMenuState;
  /** The Window menu's tab items, which only macOS has. */
  readonly tabMenu: readonly MenuItemConstructorOptions[];
  readonly checkUpdates: () => void;
  readonly command: (name: "settings" | "help" | "compose") => void;
  readonly feedback: () => void;
  /** Closes the newest sheet over the window, or the window. See `closeWindowTarget`. */
  readonly closeWindow: () => void;
  /** Opens the docs site in the default browser. */
  readonly openHelp: () => void;
  readonly attachFiles: () => void;
  readonly newWindow: () => void;
  readonly edit: (action: "undo" | "selectAll") => void;
  readonly undoSend: () => void;
  readonly nativeAction: (action: NativeAction, triggeredByAccelerator: boolean) => void;
}

export type CloseWindowTarget<W> =
  | { readonly _tag: "Sheet" | "Window"; readonly window: W }
  | { readonly _tag: "FirstResponder" }
  | { readonly _tag: "None" };

/**
 * What Close window acts on. The menu item decides when it is chosen, from the window's latest
 * menu state, so a menu built before a sheet opened or closed can't send the key elsewhere.
 * An app in the background has no key window, yet macOS still runs its menu items from a key
 * press or the accessibility menu (Sidescreen does both), so the window used last closes then.
 * While the app is active without a focused app window, a native panel such as About has the
 * keyboard, and the close goes to it.
 */
export function closeWindowTarget<W>(input: {
  readonly platform: NodeJS.Platform;
  readonly focused: W | null;
  readonly lastUsed: W | null;
  readonly appActive: boolean;
  readonly sheetOpen: (window: W) => boolean;
}): CloseWindowTarget<W> {
  const mac = input.platform === "darwin";
  const window = input.focused ?? (mac && !input.appActive ? input.lastUsed : null);
  if (window) return { _tag: input.sheetOpen(window) ? "Sheet" : "Window", window };
  return mac ? { _tag: "FirstResponder" } : { _tag: "None" };
}

/** The accelerator an action's menu item shows and registers, if it has a ⌘ key. */
export function nativeActionAccelerator(set: ShortcutSet, action: NativeAction) {
  if (action === "goOverview") return "Control+1";
  if (action === "goAllAccounts") return "Control+2";
  if (isGoSpace(action))
    return `${set === "gmail" ? "" : "Control+"}CommandOrControl+${(goSpaceIndex(action) ?? 0) + 1}`;
  if (isGoMailbox(action))
    return `${set === "gmail" ? "Control+" : ""}CommandOrControl+${goMailboxDigit(action)}`;
  // ⌘[ and ⌘] belong to the Format menu's indent while composing; Back and Forward keep them
  // in the window, unregistered here so the menu has each accelerator once.
  return action === "goBack" || action === "goForward"
    ? undefined
    : shortcutAccelerator(set, action);
}

/** The application menu bar. Pure, so its template can be tested without Electron. */
export function applicationMenuTemplate(input: AppMenuInput): MenuItemConstructorOptions[] {
  const { labels, platform, shortcutSet } = input;
  const mac = platform === "darwin";
  const label = (key: string) =>
    labels.menuLabels?.[key] ??
    DEFAULT_MENU_LABELS[key] ??
    (key[0]?.toUpperCase() ?? "") + key.slice(1).replace(/[A-Z]/g, (l) => ` ${l.toLowerCase()}`);
  const actionItem = (action: NativeAction): MenuItemConstructorOptions => ({
    label:
      input.menuState.spaces?.[goSpaceIndex(action) ?? -1] ??
      label(nativeActionLabelKey(action, input.menuState)),
    accelerator: nativeActionAccelerator(shortcutSet, action),
    enabled: nativeActionEnabled(action, input.menuState),
    click: (_item, _window, event) =>
      input.nativeAction(action, event.triggeredByAccelerator === true),
  });
  const entry = (item: NativeMenuEntry): MenuItemConstructorOptions[] => {
    if (item === "separator") return [{ type: "separator" }];
    // The Go menu lists a space for each of the window's profiles.
    const space = typeof item === "string" ? goSpaceIndex(item) : undefined;
    if (space !== undefined && space >= (input.menuState.spaces?.length ?? 0)) return [];
    if (typeof item === "string") return mac || !item.startsWith("share") ? [actionItem(item)] : [];
    return [{ label: label(item.submenu), submenu: item.actions.map(actionItem) }];
  };
  const menu = (name: (typeof NATIVE_MENUS)[number]["name"]) =>
    NATIVE_MENUS.filter((group) => group.name === name).map((group) => ({
      label: label(group.name),
      submenu: [
        ...group.entries.flatMap(entry),
        ...(name === "view"
          ? [
              { type: "separator" as const },
              {
                role: "togglefullscreen" as const,
                label: label("toggleFullScreen"),
                accelerator: shortcutAccelerator(shortcutSet, "toggleFullScreen"),
              },
            ]
          : []),
      ],
    }));
  return [
    ...(mac
      ? [
          {
            role: "appMenu" as const,
            submenu: [
              { role: "about" as const, label: label("about") },
              { label: labels.checkUpdates, click: input.checkUpdates },
              { type: "separator" as const },
              {
                label: labels.settings,
                accelerator: shortcutAccelerator(shortcutSet, "settings"),
                click: () => input.command("settings"),
              },
              { type: "separator" as const },
              { role: "hide" as const, label: label("hide"), accelerator: menuAccelerator("hide") },
              {
                role: "hideOthers" as const,
                label: label("hideOthers"),
                accelerator: menuAccelerator("hideOthers"),
              },
              { role: "unhide" as const, label: label("unhide") },
              { type: "separator" as const },
              { role: "quit" as const, label: label("quit"), accelerator: menuAccelerator("quit") },
            ],
          },
        ]
      : []),
    {
      label: labels.file,
      submenu: [
        {
          label: labels.compose,
          accelerator: shortcutAccelerator(shortcutSet, "compose"),
          click: () => input.command("compose"),
        },
        {
          label: labels.attachFiles,
          accelerator: shortcutAccelerator(shortcutSet, "attach"),
          click: input.attachFiles,
        },
        {
          label: labels.newWindow,
          accelerator: shortcutAccelerator(shortcutSet, "newWindow"),
          click: input.newWindow,
        },
        ...(mac
          ? []
          : [
              {
                label: labels.settings,
                accelerator: shortcutAccelerator(shortcutSet, "settings"),
                click: () => input.command("settings"),
              },
            ]),
        { type: "separator" },
        { label: label("close"), accelerator: menuAccelerator("close"), click: input.closeWindow },
      ],
    },
    {
      label: labels.edit,
      submenu: [
        { label: labels.undo, accelerator: "CommandOrControl+Z", click: () => input.edit("undo") },
        { label: labels.undoSend, enabled: input.undoAvailable, click: input.undoSend },
        { role: "redo", label: label("redo"), accelerator: menuAccelerator("redo") },
        { type: "separator" },
        { role: "cut", label: label("cut"), accelerator: menuAccelerator("cut") },
        { role: "copy", label: label("copy"), accelerator: menuAccelerator("copy") },
        { role: "paste", label: label("paste"), accelerator: menuAccelerator("paste") },
        {
          label: labels.selectAll,
          accelerator: menuAccelerator("selectAll"),
          click: () => input.edit("selectAll"),
        },
      ],
    },
    ...menu("view"),
    ...menu("go"),
    ...menu("message"),
    ...menu("mailbox"),
    ...menu("format"),
    {
      // The role makes it the system Window menu, which lists the open windows after our items.
      role: "windowMenu",
      label: labels.window,
      submenu: [
        { role: "minimize", label: label("minimize"), accelerator: menuAccelerator("minimize") },
        { role: "zoom", label: label("zoom") },
        { role: "front", label: label("front") },
        ...input.tabMenu,
      ],
    },
    {
      role: "help",
      label: labels.helpMenu ?? "Help",
      submenu: [
        { label: labels.docs, click: input.openHelp },
        { label: labels.help, click: () => input.command("help") },
        { label: labels.feedback, click: input.feedback },
        ...(mac ? [] : [{ label: labels.checkUpdates, click: input.checkUpdates }]),
      ],
    },
  ];
}
