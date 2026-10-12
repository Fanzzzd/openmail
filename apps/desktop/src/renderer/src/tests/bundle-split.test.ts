import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { desktopRoot } from "../test-support/paths";

// Reads the production build, as security.test.ts does. Run `pnpm build` first.
const assets = pathToFileURL(`${desktopRoot}/out/renderer/assets/`);

it("keeps rarely used screens, other locales, calendar parsing and the HTML cleaner out of the renderer entry", async () => {
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
    "MessageBody",
  ])
    expect(files.some((file) => file.startsWith(`${screen}-`) && file.endsWith(".js"))).toBe(true);
  // One chunk per locale, loaded when the language is activated.
  expect(files.filter((file) => /^messages-[\w-]+\.js$/.test(file))).toHaveLength(10);
  expect(entry).not.toContain("const messages = JSON.parse(");
  // ical.js runs code at import, so only core's sideEffects flag lets the
  // bundler drop it from the schema barrel.
  expect(entry).not.toMatch(/\bICAL\b/);
  // The reader body chunk holds core's sanitizer and DOMPurify, so the list paints first.
  expect(entry).not.toMatch(/function sanitizeReaderHtml\(/);
  expect(entry).not.toContain("DOMPurify");
});

it("keeps the router in its own vendor chunk, which the recovery window does not load", async () => {
  const files = await readdir(assets);
  const router = files.find((file) => /^router-[\w-]+\.js$/.test(file));
  if (!router) throw new Error("router chunk not found");
  // React has a chunk of its own, so the router chunk does not pull it in for recovery.html.
  expect(files.some((file) => /^react-[\w-]+\.js$/.test(file))).toBe(true);
  expect(await readFile(new URL(router, assets), "utf8")).toContain("__TSR_index");
  const entryName = /src="\.\/assets\/(index-[\w-]+\.js)"/.exec(
    await readFile(new URL("../index.html", assets), "utf8"),
  )?.[1];
  if (!entryName) throw new Error("renderer entry script not found");
  expect(await readFile(new URL(entryName, assets), "utf8")).not.toContain("__TSR_index");
  expect(await readFile(new URL("../recovery.html", assets), "utf8")).not.toContain(router);
});
