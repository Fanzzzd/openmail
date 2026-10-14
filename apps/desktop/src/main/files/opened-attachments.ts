import type { app } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeFilename } from "./attachment-filenames";

/** Folders unopened this long whose file is unchanged are removed by cleanup. */
export const OPENED_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Cleanup runs at start-up and then this often while the app runs. */
export const OPENED_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A folder without a record this old was never handed to an app: the write stopped midway. */
const UNRECORDED_GRACE_MS = 60 * 60 * 1000;
const SIDECAR = ".openmail-opened.json";
const FOLDER = /^[0-9a-f]{24}(?:-[0-9a-f]{8})?$/;

/** `account` is a hash of the account ID, so the folder holds no address. */
type Sidecar = {
  file: string;
  size: number;
  mtimeMs: number;
  openedAt: number;
  account?: string;
};

/** The sidecar's account field for an account ID. */
export const accountKey = (accountId: string) =>
  createHash("sha256").update(accountId).digest("hex").slice(0, 24);

/**
 * `tmutil addexclusion` stores this binary plist (the string "com.apple.backupd") in the
 * com_apple_backup_excludeItem attribute. Writing the attribute directly avoids running tmutil.
 */
export const BACKUP_EXCLUDE_ATTRIBUTE = "com.apple.metadata:com_apple_backup_excludeItem";
export const BACKUP_EXCLUDE_VALUE =
  "62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C";

/** Excludes a folder from Time Machine on macOS; elsewhere it does nothing. */
export const excludeFromBackup = (folder: string) =>
  process.platform === "darwin"
    ? new Promise<void>((resolve, reject) => {
        execFile(
          "/usr/bin/xattr",
          ["-wx", BACKUP_EXCLUDE_ATTRIBUTE, BACKUP_EXCLUDE_VALUE, folder],
          (error) => (error ? reject(error) : resolve()),
        );
      })
    : Promise.resolve();

/** What the opened-attachments folder holds, for Settings. */
export type OpenedAttachmentsUsage = {
  /** Bytes in all copies, edited or not. */
  bytes: number;
  copies: number;
  /** Copies changed since OpenMail wrote them, or whose record is missing or damaged. */
  edited: number;
};

/** Finder's view settings say nothing about whether the copy is in use. */
const IGNORED_ENTRIES = new Set([SIDECAR, ".DS_Store"]);

/** True when the folder holds anything besides the copy, its record and Finder's settings. */
const holdsOthers = async (folder: string, file: string) =>
  (await readdir(folder).catch(() => [])).some(
    (entry) => entry !== file && !IGNORED_ENTRIES.has(entry),
  );

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
        ...("account" in value && typeof value.account === "string"
          ? { account: value.account }
          : {}),
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

const sizeOf = async (folder: string): Promise<number> => {
  let bytes = 0;
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) bytes += await sizeOf(file);
    else if (entry.isFile()) bytes += (await stat(file).catch(() => null))?.size ?? 0;
  }
  return bytes;
};

/**
 * Attachments opened in another app. Each lives in its own 0700 folder under one per-user root
 * that outlives the app, so edits saved in place stay. Opening the same attachment again reuses
 * its copy while the copy is unchanged. Cleanup removes only copies that are still exactly as
 * written and were last opened more than `lifetime` ago. The root is excluded from Time Machine.
 */
export class OpenedAttachments {
  private excluded: Promise<void> | undefined;

  constructor(
    readonly root: string,
    private readonly lifetime = OPENED_LIFETIME_MS,
    private readonly exclude: (folder: string) => Promise<void> = excludeFromBackup,
  ) {}

  /** Creates the root once per instance and marks it for Time Machine to skip. */
  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.excluded ??= this.exclude(this.root).catch(() => {
      // A volume without extended attributes still works; the next instance retries.
    });
    await this.excluded;
  }

  /** Our copy folders under the root, owned by this user. */
  private async folders() {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    const folders: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !FOLDER.test(entry.name)) continue;
      const folder = path.join(this.root, entry.name);
      if (await owned(folder)) folders.push(folder);
    }
    return folders;
  }

  /** `key` names one attachment of one message; `accountId` lets account removal find it. */
  async write(
    key: string,
    part: { filename: string; data: Uint8Array },
    accountId?: string,
  ): Promise<{ file: string; created: boolean }> {
    await this.prepare();
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
        ...(accountId === undefined ? {} : { account: accountKey(accountId) }),
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

  /**
   * Removes copies left as written and not opened within the lifetime; edited ones stay. A
   * folder with no record is a write that stopped before any app got the file, so it goes once
   * it is an hour old. A damaged record leaves its folder alone, and so does any other entry
   * in the folder: Word's ~$ owner file or LibreOffice's .~lock file means the copy is open.
   */
  async cleanup(now = Date.now()) {
    if (await this.hasRoot()) await this.prepare();
    for (const folder of await this.folders()) {
      const record = await readSidecar(folder);
      if (!record) {
        const missing = !(await lstat(path.join(folder, SIDECAR)).then(
          () => true,
          () => false,
        ));
        const info = await stat(folder).catch(() => null);
        if (missing && info && now - info.mtimeMs >= UNRECORDED_GRACE_MS)
          await rm(folder, { recursive: true, force: true });
        continue;
      }
      const present = await stat(path.join(folder, record.file)).then(
        () => true,
        () => false,
      );
      if (present && (now - record.openedAt < this.lifetime || !(await unchanged(folder, record))))
        continue;
      if (await holdsOthers(folder, record.file)) continue;
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * After an account is removed: deletes that account's copies that are still as written and
   * returns how many edited copies stay. Copies opened before OpenMail recorded the account are
   * left to the lifetime rule.
   */
  async removeAccount(accountId: string) {
    const key = accountKey(accountId);
    let kept = 0;
    for (const folder of await this.folders()) {
      const record = await readSidecar(folder);
      if (record?.account !== key) continue;
      if (await unchanged(folder, record)) await rm(folder, { recursive: true, force: true });
      else kept++;
    }
    return kept;
  }

  /** Size and counts for Settings. */
  async usage(): Promise<OpenedAttachmentsUsage> {
    const usage = { bytes: 0, copies: 0, edited: 0 };
    for (const folder of await this.folders()) {
      const record = await readSidecar(folder);
      usage.bytes += await sizeOf(folder);
      usage.copies++;
      if (!record || !(await unchanged(folder, record))) usage.edited++;
    }
    return usage;
  }

  /** Deletes every copy, edited ones included. Settings asks first when edited copies exist. */
  async clear() {
    for (const folder of await this.folders()) await rm(folder, { recursive: true, force: true });
    return this.usage();
  }

  private hasRoot() {
    return lstat(this.root).then(
      (info) => info.isDirectory(),
      () => false,
    );
  }
}

/** The per-user folder for opened attachments, inside the app's data folder. */
export const openedAttachmentsRoot = (userData: string) =>
  path.join(userData, "Opened Attachments");

let opened: OpenedAttachments | undefined;
export function openedAttachments(application: Pick<typeof app, "getPath">) {
  return (opened ??= new OpenedAttachments(openedAttachmentsRoot(application.getPath("userData"))));
}

/** Sweep of opened copies nobody edited or reopened within the lifetime. */
export const cleanupOpenedAttachments = (userData: string) =>
  new OpenedAttachments(openedAttachmentsRoot(userData)).cleanup();
