import type { MenuItemConstructorOptions } from "electron";
import { expect, it, vi } from "vitest";
import { NativeAction, NO_MENU_SELECTION } from "../../shared/native-actions";
import { isShortcutAction, shortcutAccelerator, type ShortcutSet } from "../../shared/shortcuts";
import { applicationMenuTemplate, nativeActionAccelerator } from "./app-menu";
import { DEFAULT_DESKTOP_LABELS } from "./default-labels";

const template = (platform: NodeJS.Platform, shortcutSet: ShortcutSet = "mimestream") => {
  const nativeAction = vi.fn<(action: NativeAction, triggeredByAccelerator: boolean) => void>();
  const menu = applicationMenuTemplate({
    platform,
    labels: DEFAULT_DESKTOP_LABELS,
    shortcutSet,
    undoAvailable: false,
    menuState: NO_MENU_SELECTION,
    tabMenu: [],
    checkUpdates: vi.fn(),
    command: vi.fn(),
    feedback: vi.fn(),
    attachFiles: vi.fn(),
    newWindow: vi.fn(),
    edit: vi.fn(),
    undoSend: vi.fn(),
    nativeAction,
  });
  return { menu, nativeAction };
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
      const { menu, nativeAction } = template(platform, set);
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
    "Toggle sidebar",
    "Toggle reader",
    "Toggle reading pane",
    "Toggle toolbar",
    "---",
    "Zoom in",
    "Zoom out",
    "Zoom reset",
    "---",
    "Toggle full screen",
  ]);
  expect(labels(submenu(menu, "Go"))).toEqual([
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
  expect(roleLabel("close")).toBe("Close window");
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
  expect(items(translated).find((item) => item.role === "close")?.label).toBe("Fenster schließen");
  expect(labels(translated)).toContain("Darstellung");
});
