import { constVoid } from "effect/Function";
import type { app } from "electron";
import { mkdtemp, mkdir, writeFile, rm, readdir, lstat } from "node:fs/promises";
import { rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeFilename } from "./attachment-filenames";

export type TempBatch = { readonly folder: string; readonly files: string[] };
/** Never follow a symlink or remove another live app process's root. Legacy
 * roots have no owner PID, so remove them only after the original 30-minute TTL. */
export async function cleanupAttachmentTemps(temp: string) {
  const entries = await readdir(temp, { withFileTypes: true });
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      !/^openmail-attachments(?:-(?:\d+-)?[A-Za-z0-9]{6})?$/.test(entry.name)
    )
      continue;
    const folder = path.join(temp, entry.name);
    const info = await lstat(folder).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid())) continue;
    const owner = /^openmail-attachments-(\d+)-/.exec(entry.name)?.[1];
    if (owner) {
      try {
        process.kill(Number(owner), 0);
        continue;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") continue;
      }
    } else if (Date.now() - info.mtimeMs < 30 * 60 * 1000) continue;
    await rm(folder, { recursive: true, force: true });
  }
}

/** Print jobs normally delete their folder. Remove leftovers from a crash, never through a symlink. */
export async function cleanupPrintTemps(temp: string) {
  for (const entry of await readdir(temp, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^openmail-print(?:-[A-Za-z0-9]{6})?$/.test(entry.name)) continue;
    const folder = path.join(temp, entry.name);
    const info = await lstat(folder).catch(() => null);
    if (!info || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()))
      continue;
    // One undeletable leftover must not keep the others on disk.
    await rm(folder, { recursive: true, force: true }).catch(constVoid);
  }
}

/**
 * One private root per app process, 0700 directories and 0600 files. Batches for drag, Quick
 * Look, sharing and copying expire after `lifetime`; opened attachments live elsewhere
 * (opened-attachments.ts). A batch written under a key is reused while it lives, and the 128 MB
 * budget counts only batches the app still holds.
 */
export class AttachmentTemp {
  private readonly root: Promise<string>;
  private readonly batches = new Map<
    string,
    {
      batch: TempBatch;
      key: string | undefined;
      bytes: number;
      refs: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private bytes = 0;
  private rootPath: string | undefined;
  constructor(
    temp: string,
    private readonly lifetime = 30 * 60 * 1000,
  ) {
    this.root = cleanupAttachmentTemps(temp)
      .then(() => mkdtemp(path.join(temp, `openmail-attachments-${process.pid}-`)))
      .then((root) => {
        this.rootPath = root;
        return root;
      });
  }
  async write(parts: readonly { filename: string; data: Uint8Array }[]): Promise<string[]> {
    return (await this.writeBatch(parts)).files;
  }
  private expire(batch: TempBatch) {
    const timer = setTimeout(() => {
      void this.drop(batch).catch(constVoid);
    }, this.lifetime);
    timer.unref();
    return timer;
  }
  /** A live batch under `key` whose files are all still there. */
  private async live(key: string) {
    for (const tracked of this.batches.values()) {
      if (tracked.key !== key) continue;
      const present = await Promise.all(
        tracked.batch.files.map((file) =>
          lstat(file).then(
            (info) => info.isFile(),
            () => false,
          ),
        ),
      );
      if (present.every(Boolean)) return tracked;
    }
    return undefined;
  }
  async writeBatch(
    parts: readonly { filename: string; data: Uint8Array }[],
    key?: string,
  ): Promise<TempBatch> {
    const reused = key === undefined ? undefined : await this.live(key);
    if (reused) {
      clearTimeout(reused.timer);
      reused.timer = this.expire(reused.batch);
      reused.refs++;
      return reused.batch;
    }
    const bytes = parts.reduce((n, p) => n + p.data.byteLength, 0);
    const root = await this.root;
    if (this.bytes + bytes > 128 * 1024 * 1024)
      throw new Error("Attachment temporary storage exceeds 128 MB");
    this.bytes += bytes;
    const batch: TempBatch = { folder: path.join(root, randomUUID()), files: [] };
    try {
      await mkdir(batch.folder, { mode: 0o700 });
      for (const [index, part] of parts.entries()) {
        const directory = path.join(batch.folder, String(index));
        await mkdir(directory, { mode: 0o700 });
        const file = path.join(directory, safeFilename(part.filename));
        await writeFile(file, part.data, { mode: 0o600, flag: "wx" });
        batch.files.push(file);
      }
      this.batches.set(batch.folder, { batch, key, bytes, refs: 1, timer: this.expire(batch) });
      return batch;
    } catch (error) {
      this.bytes -= bytes;
      await rm(batch.folder, { recursive: true, force: true });
      throw error;
    }
  }
  /**
   * The batch was handed to the OS (Quick Look reads it on its own). Its files stay until they
   * expire, but they no longer count against the budget.
   */
  release(batch: TempBatch) {
    const tracked = this.batches.get(batch.folder);
    if (!tracked) return;
    this.bytes -= tracked.bytes;
    tracked.bytes = 0;
  }
  /** One holder is done with the batch; the last one removes it. */
  async remove(batch: TempBatch) {
    const tracked = this.batches.get(batch.folder);
    if (!tracked) return;
    if (--tracked.refs > 0) return;
    await this.drop(batch);
  }
  private async drop(batch: TempBatch) {
    const tracked = this.batches.get(batch.folder);
    if (!tracked) return;
    clearTimeout(tracked.timer);
    await rm(batch.folder, { recursive: true, force: true });
    // Timer/replacement cleanup may race. Release the budget once.
    if (this.batches.delete(batch.folder)) this.bytes -= tracked.bytes;
  }
  async dispose() {
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
    this.bytes = 0;
    await rm(await this.root, { recursive: true, force: true });
  }
  disposeSync() {
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    if (this.rootPath) rmSync(this.rootPath, { recursive: true, force: true });
    this.batches.clear();
    this.bytes = 0;
  }
}
let tempStore: AttachmentTemp | undefined;
export function attachmentTemp(application: Pick<typeof app, "getPath" | "once">) {
  if (!tempStore) {
    tempStore = new AttachmentTemp(application.getPath("temp"));
    const owned = tempStore;
    application.once("will-quit", () => owned.disposeSync());
  }
  return tempStore;
}
