import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  externalReaderLink,
  handleReaderNavigation,
  readerDocument,
  READER_CSP,
} from "./reader-html";

it("keeps desktop resource restrictions and adds form/base CSP before untrusted content", () => {
  const desktop = readFileSync(
    new URL("../../desktop/src/renderer/src/components/EmailFrame.tsx", import.meta.url),
    "utf8",
  );
  const base = /const BLOCKED = "([^"]+)"/.exec(desktop)?.[1];
  expect(base).toBeDefined();
  expect(READER_CSP.startsWith(base ?? "missing")).toBe(true);
  expect(READER_CSP).toContain("form-action 'none'");
  expect(READER_CSP).toContain("base-uri 'none'");
  const html = readerDocument(
    '<img src="https://example.test/image.png"><script>alert(1)</script>',
  );
  expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
  const view = readFileSync(new URL("../app/reader.tsx", import.meta.url), "utf8");
  expect(view).toContain("javaScriptEnabled={false}");
  expect(view).toContain("allowFileAccess={false}");
  expect(view).toContain("incognito={true}");
});

it("strips POST form subtrees including mixed case, quoted > attributes and malformed closing tags", () => {
  for (const fragment of [
    '<form method="POST" action="https://example.test"><input name="secret" value="body"><button>Send</button></form>',
    '<FoRm action="https://example.test/?x=>"><form><input></form></FoRm>',
    '<form action="https://example.test"><input>',
    '<form id="submit"><button formaction="https://example.test">Send</button></form>',
  ]) {
    const html = readerDocument(`<p>Message text</p>${fragment}`);
    expect(html).not.toMatch(/<\/?form\b/i);
    expect(html).not.toMatch(/<input\b|formaction=/i);
    expect(html).toContain("Message text");
  }
});

it("opens validated HTTP/HTTPS/mailto links externally and rejects every WebView navigation", async () => {
  const open = vi.fn(async () => null);
  for (const url of [
    "https://example.test/path",
    "http://example.test/",
    "mailto:person@example.test?subject=Hello",
  ]) {
    expect(externalReaderLink(url)).toBe(url);
    expect(handleReaderNavigation(url, open)).toBe(false);
  }
  expect(open.mock.calls).toEqual([
    ["https://example.test/path"],
    ["http://example.test/"],
    ["mailto:person@example.test?subject=Hello"],
  ]);
  for (const url of [
    "about:blank",
    "https://user:secret@example.test/",
    "http://%75ser@example.test/",
    "mailto://user:secret@example.test",
    "javascript:alert(1)",
    "file:///private",
    "data:text/html,test",
    "openmail://reader",
    "https://example.test/\nsecret",
    "malformed",
  ]) {
    expect(externalReaderLink(url)).toBeNull();
    expect(handleReaderNavigation(url, open)).toBe(false);
  }
  expect(open).toHaveBeenCalledTimes(3);
  expect(
    handleReaderNavigation("https://example.test/", async () => {
      throw new Error("No handler");
    }),
  ).toBe(false);
  await Promise.resolve();
});
