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

/** One private root per app process, 0700 directories and 0600 files. */
export class AttachmentTemp {
  private readonly root: Promise<string>;
  private readonly batches = new Map<
    string,
    { bytes: number; timer: ReturnType<typeof setTimeout> }
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
  async writeBatch(parts: readonly { filename: string; data: Uint8Array }[]): Promise<TempBatch> {
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
      const timer = setTimeout(() => {
        void this.remove(batch).catch(constVoid);
      }, this.lifetime);
      timer.unref();
      this.batches.set(batch.folder, { bytes, timer });
      return batch;
    } catch (error) {
      this.bytes -= bytes;
      await rm(batch.folder, { recursive: true, force: true });
      throw error;
    }
  }
  async remove(batch: TempBatch) {
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
