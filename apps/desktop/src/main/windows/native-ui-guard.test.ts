import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { desktopRoot } from "../../renderer/src/test-support/paths";

/** In-window UI is React; native popups and form controls only where docs/native-macos.md allows. */
const root = path.join(desktopRoot, "src");

const banned: readonly { name: string; pattern: RegExp }[] = [
  { name: "dialog.showMessageBox", pattern: /\bshowMessageBox(Sync)?\b/g },
  { name: "window.confirm/alert/prompt", pattern: /\bwindow\.(confirm|alert|prompt)\s*\(/g },
  { name: "<select>", pattern: /<select[\s>]/g },
  { name: "<details>", pattern: /<details[\s>]/g },
  { name: "<progress>", pattern: /<progress[\s>]/g },
  { name: "Menu.buildFromTemplate", pattern: /\bMenu\.buildFromTemplate\b/g },
  { name: "Menu.popup", pattern: /\bMenu\.popup\b|\.popup\s*\(/g },
];

/** Where each native API may appear, with the reason. */
const allowed: Record<string, readonly string[]> = {
  // Fallbacks when no renderer can draw the React prompt (quit, update result, recovery).
  "main/system/native-fallback.ts": ["dialog.showMessageBox"],
  // OS-owned surfaces: Dock menu, menu bar extra (tray) and the application menu bar.
  "main/system/system.ts": ["Menu.buildFromTemplate"],
  // Writing Tools, AutoFill and Services exist only in a native menu at the right-clicked frame.
  "main/windows/spellcheck.ts": ["Menu.buildFromTemplate", "Menu.popup"],
  // The macOS share sheet is a system service, opened through ShareMenu.
  "main/system/share-message-link.ts": ["Menu.popup"],
  "main/files/attachment-actions.ts": ["Menu.popup"],
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(full);
    return /\.(tsx?|html)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });

/** Comments may name the APIs; only code counts. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

it("no native in-window UI outside the documented allowlist", () => {
  const found: Record<string, string[]> = {};
  for (const file of sources(root)) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const text = code(readFileSync(file, "utf8"));
    for (const { name, pattern } of banned) {
      if (text.match(pattern)) (found[relative] ??= []).push(name);
    }
  }
  expect(found).toEqual(allowed);
});
