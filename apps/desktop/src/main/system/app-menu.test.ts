import { readFileSync } from "node:fs";
import type { MenuItemConstructorOptions } from "electron";
import { expect, it, vi } from "vitest";
import {
  NativeAction,
  NO_MENU_SELECTION,
  nativeActionStroke,
  type NativeMenuState,
} from "../../shared/native-actions";
import {
  isShortcutAction,
  MENU_SHORTCUTS,
  spaceShortcut,
  menuAccelerator,
  shortcutAccelerator,
  type MenuShortcut,
  type ShortcutSet,
} from "../../shared/shortcuts";
import {
  applicationMenuTemplate,
  closeWindowTarget,
  goesToMainWindow,
  nativeActionAccelerator,
  unfocusedMenuState,
} from "./app-menu";
import { DEFAULT_DESKTOP_LABELS } from "./default-labels";
import { OPENMAIL_DOCS_URL } from "../../shared/docs";
import { externalUrl } from "../../shared/external-url";

const template = (
  platform: NodeJS.Platform,
  shortcutSet: ShortcutSet = "mimestream",
  menuState: NativeMenuState = NO_MENU_SELECTION,
) => {
  const nativeAction = vi.fn<(action: NativeAction, triggeredByAccelerator: boolean) => void>();
  const openHelp = vi.fn<() => void>();
  const menu = applicationMenuTemplate({
    platform,
    labels: DEFAULT_DESKTOP_LABELS,
    shortcutSet,
    undoAvailable: false,
    menuState,
    tabMenu: [],
    checkUpdates: vi.fn(),
    command: vi.fn(),
    feedback: vi.fn(),
    closeWindow: vi.fn(),
    openHelp,
    attachFiles: vi.fn(),
    newWindow: vi.fn(),
    edit: vi.fn(),
    undoSend: vi.fn(),
    nativeAction,
  });
  return { menu, nativeAction, openHelp };
};
const items = (menu: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
  menu.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? items(item.submenu) : [])]);
const submenu = (menu: readonly MenuItemConstructorOptions[], label: string) => {
  const found = menu.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(found)) throw new Error(`Missing ${label}`);
  return found;
};
const labels = (menu: readonly MenuItemConstructorOptions[]) =>
  menu.map((item) => (item.type === "separator" ? "---" : item.label));

it("every native action is in the menu bar exactly once, and no accelerator repeats", () => {
  for (const platform of ["darwin", "win32"] as const)
    for (const set of ["mimestream", "gmail", "apple"] as const) {
      const spaces = Array.from({ length: 9 }, (_, index) => `Space ${index + 1}`);
      const { menu, nativeAction } = template(platform, set, { ...NO_MENU_SELECTION, spaces });
      for (const item of items(menu))
        if (item.click && !item.role)
          item.click(
            Object.create(null),
            undefined,
            Object.assign(Object.create(null), { triggeredByAccelerator: false }),
          );
      const clicked = nativeAction.mock.calls.map(([action]) => action);
      const expected = NativeAction.literals.filter(
        (action) => platform === "darwin" || !action.startsWith("share"),
      );
      expect(clicked.toSorted()).toEqual([...expected].toSorted());
      const accelerators = items(menu)
        .map((item) => item.accelerator)
        .filter((accelerator): accelerator is string => typeof accelerator === "string")
        .map((accelerator) => accelerator.toLowerCase());
      expect(accelerators.length).toBeGreaterThan(40);
      expect(accelerators.filter((a, index) => accelerators.indexOf(a) !== index)).toEqual([]);
    }
});

it("menu actions keep the keymap's accelerators; Go adds the folder keys", () => {
  for (const set of ["mimestream", "gmail", "apple"] as const) {
    for (const action of NativeAction.literals)
      if (isShortcutAction(action))
        expect(nativeActionAccelerator(set, action)).toBe(shortcutAccelerator(set, action));
    expect(nativeActionAccelerator(set, "goInbox")).toBe(
      set === "gmail" ? "Control+CommandOrControl+1" : "CommandOrControl+1",
    );
    expect(nativeActionAccelerator(set, "goSpam")).toMatch(/CommandOrControl\+8$/);
    // ⌘[ stays the Format menu's indent; Back keeps the key in the window.
    expect(nativeActionAccelerator(set, "goBack")).toBeUndefined();
  }
  expect(nativeActionAccelerator("mimestream", "zoomIn")).toBe("CommandOrControl+Plus");
  expect(nativeActionAccelerator("mimestream", "reply")).toBe("CommandOrControl+r");
  expect(nativeActionAccelerator("mimestream", "alignLeft")).toBe("CommandOrControl+{");
});

it("Go keeps its spaces with no focused window, and its items reach the main window", () => {
  const spacesOf = (state: NativeMenuState) =>
    labels(submenu(template("darwin", "mimestream", state).menu, "Go")).slice(0, 4);
  const work = { ...NO_MENU_SELECTION, selected: true, spaces: ["Work", "Home"] };
  // In the background: the main window's state, but nothing selected.
  const background = unfocusedMenuState([undefined, work], undefined);
  expect(background).toEqual({ ...NO_MENU_SELECTION, spaces: ["Work", "Home"] });
  expect(spacesOf(background)).toEqual(["Overview", "All accounts", "Work", "Home"]);
  // No main window reports spaces: the ones listed last stay.
  expect(spacesOf(unfocusedMenuState([], ["Work"]))).toEqual([
    "Overview",
    "All accounts",
    "Work",
    "---",
  ]);
  expect(unfocusedMenuState([], undefined)).toBe(NO_MENU_SELECTION);
  for (const action of ["goSpace1", "goOverview", "goAllAccounts", "goInbox"] as const)
    expect(goesToMainWindow(action)).toBe(true);
  for (const action of ["reply", "archive", "zoomIn"] as const)
    expect(goesToMainWindow(action)).toBe(false);
});

it("Go lists Overview, All accounts and each space with the keys that open them", () => {
  const state = { ...NO_MENU_SELECTION, spaces: ["Work", "Home"] };
  for (const set of ["mimestream", "gmail"] as const) {
    const { menu, nativeAction } = template("darwin", set, state);
    const go = submenu(menu, "Go");
    expect(labels(go).slice(0, 5)).toEqual(["Overview", "All accounts", "Work", "Home", "---"]);
    expect(go.slice(0, 4).map((item) => item.accelerator)).toEqual(
      set === "gmail"
        ? ["Control+1", "Control+2", "CommandOrControl+1", "CommandOrControl+2"]
        : ["Control+1", "Control+2", "Control+CommandOrControl+1", "Control+CommandOrControl+2"],
    );
    for (const item of go.slice(0, 4))
      item.click?.(
        Object.create(null),
        undefined,
        Object.assign(Object.create(null), { triggeredByAccelerator: false }),
      );
    expect(nativeAction.mock.calls.map(([action]) => action)).toEqual([
      "goOverview",
      "goAllAccounts",
      "goSpace1",
      "goSpace2",
    ]);
  }
  // The window gets the key the space shortcut reads.
  for (const set of ["mimestream", "gmail", "apple"] as const)
    expect(
      (["goOverview", "goAllAccounts", "goSpace3"] as const).map((action) => {
        const stroke = nativeActionStroke(set, action);
        return spaceShortcut(
          {
            key: stroke?.key ?? "",
            metaKey: Boolean(stroke?.cmd),
            ctrlKey: Boolean(stroke?.control),
            altKey: false,
            shiftKey: false,
          },
          set,
        );
      }),
    ).toEqual([{ kind: "overview" }, { kind: "all" }, { kind: "profile", index: 2 }]);
  const renamed = template("darwin", "mimestream", { ...NO_MENU_SELECTION, spaces: ["Work"] });
  expect(labels(submenu(renamed.menu, "Go")).slice(0, 4)).toEqual([
    "Overview",
    "All accounts",
    "Work",
    "---",
  ]);
});

it("the menu bar has View and Go, and Format groups its actions in submenus", () => {
  const { menu } = template("darwin");
  expect(labels(menu)).toEqual([
    undefined,
    "File",
    "Edit",
    "View",
    "Go",
    "Message",
    "Mailbox",
    "Format",
    "Window",
    "Help",
  ]);
  expect(labels(submenu(menu, "View"))).toEqual([
    "Show sidebar",
    "Show reading pane",
    "Toggle reading pane",
    "Show toolbar",
    "---",
    "Zoom in",
    "Zoom out",
    "Zoom reset",
    "---",
    "Toggle full screen",
  ]);
  expect(labels(submenu(menu, "Go"))).toEqual([
    "Overview",
    "All accounts",
    "---",
    "Inbox",
    "Starred",
    "Snoozed",
    "Drafts",
    "Sent",
    "All Mail",
    "Trash",
    "Spam",
    "---",
    "Previous view",
    "Next view",
  ]);
  const format = submenu(menu, "Format");
  expect(labels(format).slice(0, 5)).toEqual([
    "Text style",
    "Alignment",
    "Lists",
    "Quote level",
    "Direction",
  ]);
  expect(labels(submenu(format, "Alignment"))).toEqual([
    "Align left",
    "Align center",
    "Align right",
    "Align justify",
  ]);
  expect(labels(submenu(format, "Quote level"))).toEqual(["Quote increase", "Quote decrease"]);
  expect(submenu(menu, "View").find((item) => item.role === "togglefullscreen")?.accelerator).toBe(
    "Control+CommandOrControl+f",
  );
});

it("role items carry sentence-case labels instead of Electron's Title Case", () => {
  const { menu } = template("darwin");
  const all = items(menu);
  const roleLabel = (role: MenuItemConstructorOptions["role"]) =>
    all.find((item) => item.role === role)?.label;
  expect(roleLabel("hideOthers")).toBe("Hide others");
  expect(roleLabel("unhide")).toBe("Show all");
  expect(roleLabel("front")).toBe("Bring all to front");
  for (const item of all)
    if (item.role && item.role !== "appMenu" && item.role !== "help")
      expect(item.label, item.role).toMatch(/^[A-Z][^A-Z]*(?: (?:OpenMail|Mail))*$/);
  // The renderer's translated labels replace the defaults.
  const translated = applicationMenuTemplate({
    platform: "darwin",
    shortcutSet: "mimestream",
    undoAvailable: false,
    menuState: NO_MENU_SELECTION,
    tabMenu: [],
    checkUpdates: vi.fn(),
    command: vi.fn(),
    feedback: vi.fn(),
    closeWindow: vi.fn(),
    openHelp: vi.fn(),
    attachFiles: vi.fn(),
    newWindow: vi.fn(),
    edit: vi.fn(),
    undoSend: vi.fn(),
    nativeAction: vi.fn(),
    labels: {
      ...DEFAULT_DESKTOP_LABELS,
      menuLabels: { close: "Fenster schließen", view: "Darstellung" },
    },
  });
  expect(labels(submenu(translated, DEFAULT_DESKTOP_LABELS.file))).toContain("Fenster schließen");
  expect(labels(translated)).toContain("Darstellung");
});

it("the English menu labels before the renderer loads match the renderer's", () => {
  const source = readFileSync(
    new URL("../../renderer/src/state/desktop.ts", import.meta.url),
    "utf8",
  );
  const defaults: Record<string, unknown> = { ...DEFAULT_DESKTOP_LABELS };
  // The top-level labels share one indent; the nested menu labels sit deeper.
  const indent = /^(\s+)settings: t`/m.exec(source)?.[1] ?? "";
  const line = new RegExp(`^${indent}(\\w+): t\`([^\`$]*)\`,$`, "gm");
  const pairs = [...source.matchAll(line)].filter(
    ([, key]) => typeof defaults[key ?? ""] === "string",
  );
  expect(pairs.length).toBeGreaterThan(10);
  for (const [, key, text] of pairs) expect(defaults[key ?? ""], key).toBe(text);
});

it("the Message menu groups its actions with separators, none doubled or at an end", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const message = labels(submenu(template(platform).menu, "Message"));
    expect(message[0]).toBe("Reply");
    expect(message.filter((label) => label === "---").length).toBeGreaterThanOrEqual(4);
    expect(message.at(0)).not.toBe("---");
    expect(message.at(-1)).not.toBe("---");
    expect(message.join("|")).not.toContain("---|---");
    // Triage, opening and compose each start a group.
    for (const first of ["Archive", "Open thread", "Send"])
      expect(message[message.indexOf(first) - 1], first).toBe("---");
  }
});

it("Help starts with OpenMail help, which opens the docs site", () => {
  for (const platform of ["darwin", "win32"] as const) {
    const { menu, openHelp } = template(platform);
    const help = submenu(menu, "Help");
    expect(help[0]?.label).toBe("OpenMail help");
    help[0]?.click?.(
      Object.create(null),
      undefined,
      Object.assign(Object.create(null), { triggeredByAccelerator: false }),
    );
    expect(openHelp).toHaveBeenCalledOnce();
  }
  // The safe external-open path accepts the docs site.
  expect(externalUrl(OPENMAIL_DOCS_URL)).toBe(`${OPENMAIL_DOCS_URL}/`);
});

it("the View menu's pane toggles say Show or Hide by what the focused window shows", () => {
  const view = (menuState: NativeMenuState) =>
    labels(
      submenu(
        applicationMenuTemplate({
          platform: "darwin",
          labels: DEFAULT_DESKTOP_LABELS,
          shortcutSet: "mimestream",
          undoAvailable: false,
          menuState,
          tabMenu: [],
          checkUpdates: vi.fn(),
          command: vi.fn(),
          feedback: vi.fn(),
          closeWindow: vi.fn(),
          openHelp: vi.fn(),
          attachFiles: vi.fn(),
          newWindow: vi.fn(),
          edit: vi.fn(),
          undoSend: vi.fn(),
          nativeAction: vi.fn(),
        }),
        "View",
      ),
    );
  const shown = view({
    ...NO_MENU_SELECTION,
    panes: { sidebar: true, toolbar: true, reader: true },
  });
  expect(shown).toEqual(
    expect.arrayContaining(["Hide sidebar", "Hide toolbar", "Hide reading pane"]),
  );
  const hidden = view({
    ...NO_MENU_SELECTION,
    panes: { sidebar: false, toolbar: true, reader: false },
  });
  expect(hidden).toEqual(
    expect.arrayContaining(["Show sidebar", "Hide toolbar", "Show reading pane"]),
  );
  expect(hidden).not.toContain("Hide sidebar");
  // A window without panes, such as a thread window, offers to show them.
  expect(view(NO_MENU_SELECTION)).toEqual(
    expect.arrayContaining(["Show sidebar", "Show toolbar", "Show reading pane"]),
  );
});

it("Close window is one item whose target is chosen when it runs", () => {
  const closeWindow = vi.fn<() => void>();
  const build = (menuState: NativeMenuState) =>
    applicationMenuTemplate({
      platform: "darwin",
      labels: DEFAULT_DESKTOP_LABELS,
      shortcutSet: "mimestream",
      undoAvailable: false,
      menuState,
      tabMenu: [],
      checkUpdates: vi.fn(),
      command: vi.fn(),
      feedback: vi.fn(),
      closeWindow,
      openHelp: vi.fn(),
      attachFiles: vi.fn(),
      newWindow: vi.fn(),
      edit: vi.fn(),
      undoSend: vi.fn(),
      nativeAction: vi.fn(),
    });
  const close = (menuState: NativeMenuState) =>
    submenu(build(menuState), DEFAULT_DESKTOP_LABELS.file).find(
      (item) => item.label === "Close window",
    );
  // No role: the "close" role does nothing while the app has no key window.
  for (const state of [NO_MENU_SELECTION, { ...NO_MENU_SELECTION, sheet: true }]) {
    const item = close(state);
    expect(item?.role).toBeUndefined();
    expect(item?.accelerator).toBe(menuAccelerator("close"));
  }
  close(NO_MENU_SELECTION)?.click?.(
    Object.create(null),
    undefined,
    Object.assign(Object.create(null), { triggeredByAccelerator: true }),
  );
  expect(closeWindow).toHaveBeenCalledOnce();
});

it("Close window closes the focused window's sheet, else the window", () => {
  const sheets = new Set(["covered"]);
  const target = (input: Partial<Parameters<typeof closeWindowTarget<string>>[0]>) =>
    closeWindowTarget<string>({
      platform: "darwin",
      focused: null,
      lastUsed: null,
      appActive: true,
      sheetOpen: (window) => sheets.has(window),
      ...input,
    });
  expect(target({ focused: "covered" })).toEqual({ _tag: "Sheet", window: "covered" });
  expect(target({ focused: "plain", lastUsed: "covered" })).toEqual({
    _tag: "Window",
    window: "plain",
  });
  // In the background (Sidescreen, the accessibility menu) the window used last closes.
  expect(target({ appActive: false, lastUsed: "plain" })).toEqual({
    _tag: "Window",
    window: "plain",
  });
  expect(target({ appActive: false, lastUsed: "covered" })).toEqual({
    _tag: "Sheet",
    window: "covered",
  });
  // Active without an app window focused: a native panel such as About has the keyboard.
  expect(target({ lastUsed: "plain" })).toEqual({ _tag: "FirstResponder" });
  expect(target({ appActive: false })).toEqual({ _tag: "FirstResponder" });
  expect(target({ platform: "win32", appActive: false, lastUsed: "plain" })).toEqual({
    _tag: "None",
  });
  expect(target({ platform: "win32", focused: "plain" })).toEqual({
    _tag: "Window",
    window: "plain",
  });
});

it("the Window menu is the system Window menu and keeps its own items first", () => {
  const { menu } = template("darwin");
  const window = menu.find((item) => item.label === DEFAULT_DESKTOP_LABELS.window);
  expect(window?.role).toBe("windowMenu");
  expect(labels(submenu(menu, DEFAULT_DESKTOP_LABELS.window))).toEqual([
    "Minimize",
    "Zoom",
    "Bring all to front",
  ]);
});

// The docs page lists the standard menu keys, so the menu must set the same ones.
it("standard menu items carry the fixed accelerators the docs page lists", () => {
  const { menu } = template("darwin");
  const byRole = new Map(
    items(menu)
      .filter((item) => typeof item.role === "string")
      .map((item) => [item.role, item.accelerator]),
  );
  const roles: [MenuShortcut, MenuItemConstructorOptions["role"]][] = [
    ["redo", "redo"],
    ["cut", "cut"],
    ["copy", "copy"],
    ["paste", "paste"],
    ["minimize", "minimize"],
    ["hide", "hide"],
    ["hideOthers", "hideOthers"],
    ["quit", "quit"],
  ];
  for (const [item, role] of roles) expect(byRole.get(role), item).toBe(menuAccelerator(item));
  expect([...roles.map(([item]) => item), "close", "selectAll"].toSorted()).toEqual(
    Object.keys(MENU_SHORTCUTS).toSorted(),
  );
  expect(
    items(menu).find((item) => item.label === DEFAULT_DESKTOP_LABELS.selectAll)?.accelerator,
  ).toBe(menuAccelerator("selectAll"));
  expect(items(menu).find((item) => item.label === "Close window")?.accelerator).toBe(
    menuAccelerator("close"),
  );
});
