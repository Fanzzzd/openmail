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

it("blocks refresh and resource hints while preserving stylesheet links", () => {
  const html = readerDocument(
    '<META HTTP-EQUIV="refresh" content="0;url=https://evil.test/?id=secret"><meta http-equiv="Content-Security-Policy" content="img-src *"><link rel="prefetch" href="https://evil.test"><link href="https://evil.test"><link rel="stylesheet" href="https://styles.test/theme.css"><p>Message text</p>',
  );
  expect(html).not.toContain("evil.test");
  expect(html).toContain('rel="stylesheet"');
  expect(html.match(/http-equiv=/gi)).toHaveLength(1);
  expect(readerDocument('<img src="http://images.test/a">', true)).toContain(
    "img-src data: cid: https:",
  );
  expect(readerDocument("", true)).not.toContain("img-src data: cid: https: http:");
  expect(
    readerDocument('<img src="cid:photo">', false, { photo: "data:image/png;base64,AQID" }),
  ).toContain('src="data:image/png;base64,AQID"');
});

it("iOS opens only top-frame clicks and Android confirms every destination", async () => {
  const open = vi.fn(async () => null);
  const confirm = vi.fn();
  for (const type of ["other", "reload", "formsubmit", "backforward"]) {
    expect(
      handleReaderNavigation(
        { url: "https://evil.test/?id=secret", isTopFrame: true, navigationType: type },
        "ios",
        open,
        confirm,
      ),
    ).toBe(false);
  }
  expect(open).not.toHaveBeenCalled();
  expect(confirm).not.toHaveBeenCalled();
  handleReaderNavigation(
    { url: "https://example.test/path", isTopFrame: true, navigationType: "click" },
    "ios",
    open,
    confirm,
  );
  handleReaderNavigation(
    { url: "https://example.test/frame", isTopFrame: false, navigationType: "click" },
    "ios",
    open,
    confirm,
  );
  expect(open.mock.calls).toEqual([["https://example.test/path"]]);
  handleReaderNavigation(
    { url: "https://xn--bcher-kva.example/path", isTopFrame: true, navigationType: "other" },
    "android",
    open,
    confirm,
  );
  expect(confirm).toHaveBeenCalledWith({
    url: "https://xn--bcher-kva.example/path",
    destination: "xn--bcher-kva.example (bücher.example)",
  });
  expect(open).toHaveBeenCalledTimes(1);
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
    expect(
      handleReaderNavigation(
        { url, isTopFrame: true, navigationType: "click" },
        "ios",
        open,
        confirm,
      ),
    ).toBe(false);
  }
  for (const url of [
    "https://example.test/path",
    "http://example.test/",
    "mailto:person@example.test?subject=Hello",
  ])
    expect(externalReaderLink(url)).toBe(url);
  expect(
    handleReaderNavigation(
      { url: "https://example.test/", isTopFrame: true, navigationType: "click" },
      "ios",
      async () => {
        throw new Error("No handler");
      },
      confirm,
    ),
  ).toBe(false);
  await Promise.resolve();
});

it("Android confirms links when release events omit isTopFrame", () => {
  const open = vi.fn(async () => null);
  const confirm = vi.fn();
  expect(
    handleReaderNavigation(
      { url: "https://example.test/path", navigationType: "other" },
      "android",
      open,
      confirm,
    ),
  ).toBe(false);
  expect(confirm).toHaveBeenCalledWith({
    url: "https://example.test/path",
    destination: "example.test",
  });
  handleReaderNavigation(
    { url: "https://example.test/frame", isTopFrame: false },
    "android",
    open,
    confirm,
  );
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(open).not.toHaveBeenCalled();
});
