import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { KEYMAP, MENU_SHORTCUTS } from "../../desktop/src/shared/shortcuts";
import { GROUPS, MENU_NAMES, parseActionNames, renderShortcutsPage } from "./keyboard-shortcuts";

const names = parseActionNames(
  readFileSync(
    fileURLToPath(
      new URL("../../desktop/src/renderer/src/i18n/shortcut-names.ts", import.meta.url),
    ),
    "utf8",
  ),
);

test("every desktop shortcut action appears in exactly one group", () => {
  const grouped = GROUPS.flatMap((group) => group.actions);
  expect(new Set(grouped).size).toBe(grouped.length);
  expect(grouped.toSorted()).toEqual(Object.keys(KEYMAP.mimestream).toSorted());
});

test("the page lists the standard menu shortcuts, such as Close window", () => {
  const page = renderShortcutsPage(names);
  expect(page).toContain("| Close window | ⌘W |");
  expect(page).toContain("| Quit OpenMail | ⌘Q |");
  expect(Object.keys(MENU_NAMES).toSorted()).toEqual(Object.keys(MENU_SHORTCUTS).toSorted());
});

test("the keyboard shortcuts page matches the desktop keymap", async () => {
  await expect(renderShortcutsPage(names)).toMatchFileSnapshot(
    "../content/docs/keyboard-shortcuts.mdx",
  );
});
