import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AttachmentTemp } from "./attachment-temp";

// E9-4: each preview of the same file wrote a new batch that held 128 MB budget for 30 minutes.
it("reopening one 30 MB attachment reuses its batch instead of exhausting the budget", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "om-temp-budget-"));
  const store = new AttachmentTemp(temp);
  const pdf = { filename: "scan.pdf", data: new Uint8Array(30 * 1024 * 1024) };
  try {
    const first = await store.writeBatch([pdf], "message/1");
    for (let i = 2; i <= 6; i++)
      expect((await store.writeBatch([pdf], "message/1")).folder).toBe(first.folder);
  } finally {
    await store.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});

it("batches handed to Quick Look stop counting against the budget", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "om-temp-release-"));
  const store = new AttachmentTemp(temp);
  try {
    for (let i = 1; i <= 6; i++) {
      const batch = await store.writeBatch([
        { filename: `scan-${i}.pdf`, data: new Uint8Array(30 * 1024 * 1024) },
      ]);
      store.release(batch);
    }
    // Held batches still count.
    await store.writeBatch([{ filename: "a.pdf", data: new Uint8Array(100 * 1024 * 1024) }]);
    await expect(
      store.writeBatch([{ filename: "b.pdf", data: new Uint8Array(30 * 1024 * 1024) }]),
    ).rejects.toThrow(/exceeds 128 MB/);
  } finally {
    await store.dispose();
    await rm(temp, { recursive: true, force: true });
  }
});
