import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ clipboard: { read: vi.fn() } }));

import { readClipboardAttachments } from "./clipboard-attachments";

const entry = (type: string, payload: Blob) => ({
  types: [type],
  getType: async () => payload,
});

it("a text URI list cannot cause the main process to read a local secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-untrusted-uri-"));
  try {
    const path = join(directory, "secret.txt");
    await writeFile(path, "private bytes");
    expect(
      await readClipboardAttachments([
        entry("text/uri-list", new Blob([pathToFileURL(path).href])),
      ]),
    ).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("file URI lists, including local paths, are ignored without reading files", async () => {
  const getType = vi.fn(async () => new Blob(["file:///tmp/a%20b.png\nhttps://evil.test/a.png"]));
  expect(await readClipboardAttachments([{ types: ["text/uri-list"], getType }])).toEqual([]);
  expect(getType).not.toHaveBeenCalled();
});

it("clipboard images become byte attachments; HTML and SVG never supply remote image sources", async () => {
  expect(
    await readClipboardAttachments([
      entry("text/html", new Blob(['<img src="https://evil.test/tracker">'])),
      entry("image/svg+xml", new Blob(['<svg onload="evil()"/>'])),
      entry("image/png", new Blob([new Uint8Array([0, 1, 2])], { type: "image/png" })),
    ]),
  ).toEqual([{ filename: "clipboard-1.png", mimeType: "image/png", content: "AAEC" }]);
});

it("clipboard images are capped in aggregate before an oversized payload is decoded", async () => {
  const first = new Blob(["a"]);
  const second = new Blob(["b"]);
  for (const blob of [first, second])
    Object.defineProperty(blob, "size", { value: 16 * 1024 * 1024 });
  const decode = vi.spyOn(second, "arrayBuffer");
  await expect(
    readClipboardAttachments([entry("image/png", first), entry("image/png", second)]),
  ).rejects.toThrow("30 MB");
  expect(decode).not.toHaveBeenCalled();
});
