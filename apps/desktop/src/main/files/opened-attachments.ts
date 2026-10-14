import type { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFilename } from "./attachment-filenames";

/** Folders unopened this long whose file is unchanged are removed at start-up. */
export const OPENED_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SIDECAR = ".openmail-opened.json";

type Sidecar = { file: string; size: number; mtimeMs: number; openedAt: number };

const readSidecar = async (folder: string): Promise<Sidecar | null> => {
  const text = await readFile(path.join(folder, SIDECAR), "utf8").catch(() => null);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "file" in value &&
      "size" in value &&
      "mtimeMs" in value &&
      "openedAt" in value &&
      typeof value.file === "string" &&
      typeof value.size === "number" &&
      typeof value.mtimeMs === "number" &&
      typeof value.openedAt === "number" &&
      path.basename(value.file) === value.file
    )
      return {
        file: value.file,
        size: value.size,
        mtimeMs: value.mtimeMs,
        openedAt: value.openedAt,
      };
  } catch {
    // A damaged record leaves the folder alone.
  }
  return null;
};

/** The file as written: an edit saved by the default app changes its size or mtime. */
const unchanged = async (folder: string, record: Sidecar) => {
  const info = await stat(path.join(folder, record.file)).catch(() => null);
  return !!info?.isFile() && info.size === record.size && info.mtimeMs === record.mtimeMs;
};

const owned = async (folder: string) => {
  const info = await lstat(folder).catch(() => null);
  return (
    !!info &&
    info.isDirectory() &&
    !info.isSymbolicLink() &&
    (!process.getuid || info.uid === process.getuid())
  );
};

/**
 * Attachments opened in another app. Each lives in its own 0700 folder under one per-user root
 * that outlives the app, so edits saved in place stay. Opening the same attachment again reuses
 * its copy while the copy is unchanged. Cleanup removes only copies that are still exactly as
 * written and were last opened more than `lifetime` ago.
 */
export class OpenedAttachments {
  constructor(
    readonly root: string,
    private readonly lifetime = OPENED_LIFETIME_MS,
  ) {}

  /** `key` names one attachment of one message. */
  async write(
    key: string,
    part: { filename: string; data: Uint8Array },
  ): Promise<{ file: string; created: boolean }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const prefix = createHash("sha256").update(key).digest("hex").slice(0, 24);
    const name = safeFilename(part.filename);
    for (const entry of await readdir(this.root)) {
      if (entry !== prefix && !entry.startsWith(`${prefix}-`)) continue;
      const folder = path.join(this.root, entry);
      if (!(await owned(folder))) continue;
      const record = await readSidecar(folder);
      if (!record || record.file !== name || record.size !== part.data.byteLength) continue;
      if (!(await unchanged(folder, record))) continue;
      await writeFile(
        path.join(folder, SIDECAR),
        JSON.stringify({ ...record, openedAt: Date.now() }),
        { mode: 0o600 },
      );
      return { file: path.join(folder, name), created: false };
    }
    // An edited copy keeps its folder; this copy gets a new one next to it.
    let folder = path.join(this.root, prefix);
    if (
      await lstat(folder).then(
        () => true,
        () => false,
      )
    )
      folder = path.join(this.root, `${prefix}-${randomUUID().slice(0, 8)}`);
    await mkdir(folder, { mode: 0o700 });
    const file = path.join(folder, name);
    try {
      await writeFile(file, part.data, { mode: 0o600, flag: "wx" });
      const info = await stat(file);
      const record: Sidecar = {
        file: name,
        size: info.size,
        mtimeMs: info.mtimeMs,
        openedAt: Date.now(),
      };
      await writeFile(path.join(folder, SIDECAR), JSON.stringify(record), {
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      throw error;
    }
    return { file, created: true };
  }

  /** Removes a copy this call created and no app has opened. */
  async discard(file: string) {
    const folder = path.dirname(file);
    if (path.dirname(folder) !== this.root || !(await owned(folder))) return;
    await rm(folder, { recursive: true, force: true });
  }

  /** Removes copies left as written and not opened within the lifetime; edited ones stay. */
  async cleanup(now = Date.now()) {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[0-9a-f]{24}(?:-[0-9a-f]{8})?$/.test(entry.name)) continue;
      const folder = path.join(this.root, entry.name);
      if (!(await owned(folder))) continue;
      const record = await readSidecar(folder);
      if (!record) continue;
      const present = await stat(path.join(folder, record.file)).then(
        () => true,
        () => false,
      );
      if (present && (now - record.openedAt < this.lifetime || !(await unchanged(folder, record))))
        continue;
      await rm(folder, { recursive: true, force: true });
    }
  }
}

/** The per-user folder for opened attachments, inside the app's data folder. */
export const openedAttachmentsRoot = (userData: string) =>
  path.join(userData, "Opened Attachments");

let opened: OpenedAttachments | undefined;
export function openedAttachments(application: Pick<typeof app, "getPath">) {
  return (opened ??= new OpenedAttachments(openedAttachmentsRoot(application.getPath("userData"))));
}

/** Start-up sweep of opened copies nobody edited or reopened within the lifetime. */
export const cleanupOpenedAttachments = (userData: string) =>
  new OpenedAttachments(openedAttachmentsRoot(userData)).cleanup();
