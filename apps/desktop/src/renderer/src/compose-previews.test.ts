import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeInlinePreviewCache } from "./compose-previews";
import { parseHTML } from "linkedom";

it("inline previews reuse URLs across body edits and array copies, but invalidate changed bytes", () => {
  let next = 0;
  const create = vi.fn(() => `blob:${++next}`);
  const revoke = vi.fn();
  const cache = makeInlinePreviewCache(create, revoke);
  const part = {
    filename: "a.png",
    mimeType: "image/png",
    content: "AAEC",
    contentId: "a@openmail",
  };
  cache.sync([part]);
  for (let i = 0; i < 100; i++) {
    cache.sync([{ ...part }]);
    expect(cache.get(part.contentId)).toBe("blob:1");
  }
  expect(create).toHaveBeenCalledTimes(1);
  expect(revoke).not.toHaveBeenCalled();
  cache.sync([{ ...part, content: "AwQF" }]);
  expect(cache.get(part.contentId)).toBe("blob:2");
  expect(revoke).toHaveBeenCalledWith("blob:1");
  cache.sync([]);
  expect(cache.get(part.contentId)).toBeUndefined();
  expect(revoke).toHaveBeenCalledWith("blob:2");
  cache.sync([part]);
  cache.dispose();
  cache.dispose();
  expect(revoke).toHaveBeenCalledTimes(3);
});

it("renderer image CSP permits Blob previews and continues to exclude file URLs", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const csp =
    parseHTML(html).document.querySelector("meta[http-equiv]")?.getAttribute("content") ?? "";
  const directive = csp.match(/img-src ([^;]+)/)?.[1]?.split(" ") ?? [];
  expect(directive).toContain("blob:");
  expect(directive).not.toContain("file:");
});
