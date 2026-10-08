import { readdir, readFile } from "node:fs/promises";
import { expect, it } from "vitest";

// Reads the production build, as security.test.ts does. Run `pnpm build` first.
const assets = new URL("../../../out/renderer/assets/", import.meta.url);

it("keeps rarely used screens, other locales and calendar parsing out of the renderer entry", async () => {
  const html = await readFile(new URL("../index.html", assets), "utf8");
  const entryName = /src="\.\/assets\/(index-[\w-]+\.js)"/.exec(html)?.[1];
  if (!entryName) throw new Error("renderer entry script not found");
  const entry = await readFile(new URL(entryName, assets), "utf8");
  const files = await readdir(assets);
  for (const screen of [
    "Settings",
    "ServerSettings",
    "Composer",
    "ComposeEditor",
    "AddAccountDialog",
    "InviteBanner",
    "Proposals",
    "RawMessage",
  ])
    expect(files.some((file) => file.startsWith(`${screen}-`) && file.endsWith(".js"))).toBe(true);
  // One chunk per locale, loaded when the language is activated.
  expect(files.filter((file) => /^messages-[\w-]+\.js$/.test(file))).toHaveLength(10);
  expect(entry).not.toContain("const messages = JSON.parse(");
  // ical.js runs code at import, so only core's sideEffects flag lets the
  // bundler drop it from the schema barrel.
  expect(entry).not.toMatch(/\bICAL\b/);
});
