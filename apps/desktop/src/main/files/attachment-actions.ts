import { attachmentImportKind } from "@openmail/core/schema";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import {
  app,
  clipboard,
  ClipboardItem,
  nativeImage,
  ShareMenu,
  shell,
  type BrowserWindow,
} from "electron";
import {
  logWarning,
  DeviceError,
  deviceFailure,
  type AttachmentAction,
  type AttachmentActionResult,
  type Mailbox,
  type PerformError,
} from "@openmail/core";
import { previewFile, showOpenDialog } from "../windows/reveal";
import { attachmentTemp, type TempBatch } from "./attachment-temp";
import { openedAttachments } from "./opened-attachments";
import { EXECUTABLE, launcherBlockedMessage, safeFilename } from "./attachment-filenames";
import {
  attachmentAppLabels,
  registeredAttachmentApps,
  openAttachmentWith,
} from "./attachment-apps";
import { createDownloads, type Downloads } from "./downloads";
import type { AttachmentApp } from "../../shared/downloads";
import { quarantine } from "../security/file-quarantine";

type Request = {
  messageId: string;
  paths: readonly (readonly number[])[];
  action: AttachmentAction;
  listId?: string;
  application?: string;
};
type DragRequest = Pick<Request, "messageId" | "paths" | "listId">;
type Prepared =
  | { kind: "loading"; token: symbol }
  | { kind: "ready"; token: symbol; key: string; batch: TempBatch; expires: number };
const keyOf = (request: DragRequest) => JSON.stringify([request.messageId, request.paths]);
const prepared = new WeakMap<BrowserWindow, Map<string, Prepared>>();
const slotOf = (request: { messageId: string; listId?: string }) =>
  request.listId ?? request.messageId;
const countResult = (count: number): AttachmentActionResult => ({ count, failures: [] });
const isBlocked = (file: { filename: string; mimeType: string }) =>
  EXECUTABLE.test(safeFilename(file.filename)) || attachmentImportKind(file) !== null;
const blocked = (parts: readonly { filename: string; mimeType?: string }[]) => {
  const file = parts.find((part) =>
    isBlocked({ filename: part.filename, mimeType: part.mimeType ?? "" }),
  );
  return file
    ? Effect.fail(new DeviceError({ message: launcherBlockedMessage(safeFilename(file.filename)) }))
    : Effect.void;
};
const resolve = Effect.fnUntraced(function* (m: Mailbox["Service"], request: DragRequest) {
  const resolved = yield* m.reading.attachmentParts(request.messageId, request.paths);
  const parts: Effect.Success<ReturnType<Mailbox["Service"]["reading"]["attachmentPart"]>>[] = [];
  for (const part of resolved) {
    if (part.kind === "failed") return yield* part.error;
    parts.push(part.content);
  }
  yield* blocked(parts);
  return parts;
});
const temporary = Effect.fnUntraced(function* (
  parts: readonly { filename: string; data: Uint8Array }[],
  key?: string,
) {
  const batch = yield* Effect.tryPromise({
    try: () => attachmentTemp(app).writeBatch(parts, key),
    catch: deviceFailure,
  });
  for (const file of batch.files) yield* quarantine(file);
  return batch;
});
const remove = (batch: TempBatch) =>
  Effect.tryPromise({ try: () => attachmentTemp(app).remove(batch), catch: deviceFailure });

export const releaseAttachmentDrag = (
  parent: BrowserWindow | null,
  request: { messageId: string; listId?: string },
) =>
  Effect.gen(function* () {
    const slots = parent && prepared.get(parent);
    const key = slotOf(request);
    const slot = slots?.get(key);
    slots?.delete(key);
    if (slot?.kind === "ready") yield* remove(slot.batch);
  });
/** Prepare only when the drag control is approached. Replacement and cancelled
 * preparations reclaim disk bytes; outer and embedded lists have separate slots. */
export const prepareAttachmentDrag: (
  m: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: DragRequest,
) => Effect.Effect<void, PerformError | DeviceError> = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: DragRequest,
) {
  if (!parent || parent.isDestroyed())
    return yield* new DeviceError({ message: "Attachment window is closed" });
  let slots = prepared.get(parent);
  if (!slots) {
    slots = new Map();
    prepared.set(parent, slots);
    const owned = slots;
    parent.once("closed", () => {
      prepared.delete(parent);
      for (const slot of owned.values())
        if (slot.kind === "ready")
          void attachmentTemp(app)
            .remove(slot.batch)
            .catch((error: unknown) => {
              Effect.runSync(
                logWarning("attachment-cleanup-failed", "Attachment drag cleanup failed", error),
              );
            });
      owned.clear();
    });
  }
  const slotId = slotOf(request);
  const key = keyOf(request);
  const previous = slots.get(slotId);
  if (previous?.kind === "ready" && previous.key === key && previous.expires > Date.now())
    return yield* Effect.void;
  if (!previous && slots.size >= 32)
    return yield* new DeviceError({ message: "Too many prepared attachment lists" });
  const token = Symbol();
  slots.set(slotId, { kind: "loading", token });
  if (previous?.kind === "ready") yield* remove(previous.batch);
  const parts = yield* resolve(m, request);
  if (parent.isDestroyed() || slots.get(slotId)?.token !== token) return yield* Effect.void;
  // Unkeyed: each slot owns its batch, so replacing a selection frees its files at once.
  const batch = yield* temporary(parts);
  if (parent.isDestroyed() || slots.get(slotId)?.token !== token) yield* remove(batch);
  else
    slots.set(slotId, { kind: "ready", token, key, batch, expires: Date.now() + 25 * 60 * 1000 });
  return yield* Effect.void;
});

/** Downloads go to the attachment folder setting. "ask" is a legacy value that now means Downloads. */
export const attachmentFolder: (
  m: { readonly app: Pick<Mailbox["Service"]["app"], "prefs"> },
  downloadsPath: string,
) => Effect.Effect<string, DeviceError> = Effect.fnUntraced(function* (
  m: { readonly app: Pick<Mailbox["Service"]["app"], "prefs"> },
  downloadsPath: string,
) {
  const setting = (yield* m.app.prefs).attachmentSaveFolder;
  const folder = setting?.kind === "custom" ? setting.path.trim() : downloadsPath;
  if (!path.isAbsolute(folder))
    return yield* new DeviceError({ message: "Choose an absolute attachment folder path" });
  yield* Effect.tryPromise({ try: () => mkdir(folder, { recursive: true }), catch: deviceFailure });
  return folder;
});

let downloads: Downloads | undefined;
/** One list for the app, shared by every window's Downloads panel. */
export const appDownloads = (m: Mailbox["Service"], run: (effect: Effect.Effect<void>) => void) =>
  (downloads ??= createDownloads({
    fetch: (source) => m.reading.attachmentPart(source.messageId, source.path),
    blocked: isBlocked,
    quarantine,
    openPath: (file) => shell.openPath(file),
    showItem: (file) => shell.showItemInFolder(file),
    run,
  }));

const pathKey = (value: readonly number[]) => value.join(".");
/** More attachments than one message plausibly has; caps what one renderer call can queue. */
const MAX_DOWNLOADS_PER_CALL = 500;
/** Queues downloads with the names and sizes the reader shows, before any content arrives. */
export const queueDownloads: (
  m: Mailbox["Service"],
  list: Downloads,
  request: Pick<Request, "messageId" | "paths">,
  folder: string,
) => Effect.Effect<number, DeviceError> = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  list: Downloads,
  request: Pick<Request, "messageId" | "paths">,
  folder: string,
) {
  if (request.paths.length > MAX_DOWNLOADS_PER_CALL)
    return yield* new DeviceError({ message: "Too many attachments in one save" });
  const listed = yield* m.reading
    .readerAttachments(request.messageId)
    .pipe(Effect.orElseSucceed(() => []));
  return list.start(
    request.paths.map((value) => {
      const known = listed.find((file) => pathKey(file.path) === pathKey(value));
      return {
        messageId: request.messageId,
        path: value,
        filename: known?.filename ?? "attachment",
        size: known?.size ?? 0,
      };
    }),
    folder,
  );
});

/**
 * Save As: the OS folder picker is the only way the renderer can name a folder.
 * The main process receives the path from the system dialog, so a compromised
 * renderer cannot direct writes elsewhere. Plain Save never shows a dialog.
 */
export const saveAttachmentsTo: (
  m: Mailbox["Service"],
  list: Downloads,
  parent: BrowserWindow | null,
  request: Pick<Request, "messageId" | "paths">,
) => Effect.Effect<number, DeviceError> = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  list: Downloads,
  parent: BrowserWindow | null,
  request: Pick<Request, "messageId" | "paths">,
) {
  const options = {
    defaultPath: app.getPath("downloads"),
    properties: ["openDirectory", "createDirectory"] satisfies (
      | "openDirectory"
      | "createDirectory"
    )[],
  };
  const choice = yield* Effect.tryPromise({
    try: () => showOpenDialog(parent, options),
    catch: deviceFailure,
  });
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder) return 0;
  return yield* queueDownloads(m, list, request, folder);
});

type OpenedCopy = { file: string; created: boolean };

/** `name` in `folder`, reusing a file there with the same bytes, else a free "name (2)" path. */
const intoFolder = (folder: string, part: { filename: string; data: Uint8Array }) =>
  Effect.tryPromise({
    try: async (): Promise<OpenedCopy> => {
      const name = safeFilename(part.filename);
      const ext = path.extname(name);
      const stem = name.slice(0, name.length - ext.length);
      for (let n = 1; ; n++) {
        const file = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
        const existing = await stat(file).catch(() => null);
        if (!existing) {
          await writeFile(file, part.data, { flag: "wx" });
          return { file, created: true };
        }
        if (
          existing.isFile() &&
          existing.size === part.data.byteLength &&
          Buffer.from(await readFile(file)).equals(Buffer.from(part.data))
        )
          return { file, created: false };
      }
    },
    catch: deviceFailure,
  });

/**
 * Open and Open With hand the file to another app, which may keep it open for days and save
 * edits in place. The copy goes to Downloads (the attachment folder) when "Open attachments
 * from" says so, else to the per-user opened-attachments folder. Neither expires like the
 * temporary batches.
 */
const openedCopies = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  request: DragRequest,
  parts: readonly { filename: string; data: Uint8Array }[],
) {
  const downloadFolder =
    (yield* m.app.prefs).attachmentOpenFolder === "downloads"
      ? yield* attachmentFolder(m, app.getPath("downloads"))
      : undefined;
  // Recorded with each internal copy, so removing the account can delete its unchanged copies.
  const accountId = downloadFolder
    ? undefined
    : (yield* m.reading.messageAccounts([request.messageId])).get(request.messageId);
  const copies: OpenedCopy[] = [];
  for (const [index, part] of parts.entries()) {
    const copy = downloadFolder
      ? yield* intoFolder(downloadFolder, part)
      : yield* Effect.tryPromise({
          try: () =>
            openedAttachments(app).write(
              keyOf({ messageId: request.messageId, paths: [request.paths[index] ?? []] }),
              part,
              accountId,
            ),
          catch: deviceFailure,
        });
    yield* quarantine(copy.file);
    copies.push(copy);
  }
  // A launch that fails leaves nothing new in the internal folder.
  const discard = downloadFolder
    ? Effect.void
    : Effect.forEach(
        copies.filter((copy) => copy.created),
        (copy) =>
          Effect.tryPromise({
            try: () => openedAttachments(app).discard(copy.file),
            catch: deviceFailure,
          }).pipe(
            Effect.catchCause((cause) =>
              logWarning("attachment-cleanup-failed", "Opened attachment cleanup failed", cause),
            ),
          ),
        { discard: true },
      );
  return { files: copies.map((copy) => copy.file), discard };
});

const openFiles = Effect.fnUntraced(function* (files: readonly string[]) {
  for (const file of files) {
    yield* Effect.tryPromise({ try: () => stat(file), catch: deviceFailure });
    const error = yield* Effect.tryPromise({
      try: () => shell.openPath(file),
      catch: deviceFailure,
    });
    if (error) return yield* new DeviceError({ message: error });
  }
  return countResult(files.length);
});

/** The apps that can open one attachment. The file is written to a temporary folder and removed again. */
export const attachmentApps: (
  m: Mailbox["Service"],
  request: { messageId: string; path: readonly number[] },
) => Effect.Effect<AttachmentApp[], PerformError | DeviceError> = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  request: { messageId: string; path: readonly number[] },
) {
  if (process.platform !== "darwin")
    return yield* new DeviceError({
      message: "Choose one attachment on macOS to open with an application.",
    });
  const batch = yield* temporary(
    yield* resolve(m, { ...request, paths: [request.path] }),
    keyOf({ messageId: request.messageId, paths: [request.path] }),
  );
  return yield* Effect.gen(function* () {
    const file = batch.files[0];
    if (!file) return [];
    const applications = yield* registeredAttachmentApps(file);
    const labels = attachmentAppLabels(applications);
    return applications.map((application, index) => ({
      application,
      label: labels[index] ?? application,
    }));
  }).pipe(
    Effect.ensuring(
      remove(batch).pipe(
        Effect.catchCause((cause) =>
          logWarning("attachment-cleanup-failed", "Open With cleanup failed", cause),
        ),
      ),
    ),
  );
});

/** Only Save exports launchers. Open, preview, sharing, copy and drag all use
 * the same block before any file is passed to another app or native menu. */
export const attachmentAction: (
  m: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: Request,
  list: Downloads,
) => Effect.Effect<AttachmentActionResult, PerformError | DeviceError> = Effect.fnUntraced(
  function* (
    m: Mailbox["Service"],
    parent: BrowserWindow | null,
    request: Request,
    list: Downloads,
  ) {
    if (request.action === "save")
      return countResult(
        yield* queueDownloads(
          m,
          list,
          request,
          yield* attachmentFolder(m, app.getPath("downloads")),
        ),
      );
    if (request.action === "drag") {
      const cached = parent && prepared.get(parent)?.get(slotOf(request));
      if (
        !parent ||
        parent.isDestroyed() ||
        cached?.kind !== "ready" ||
        cached.key !== keyOf(request) ||
        cached.expires <= Date.now()
      )
        return yield* new DeviceError({ message: "Prepare attachments before dragging" });
      yield* blocked(cached.batch.files.map((file) => ({ filename: path.basename(file) })));
      const first = cached.batch.files[0];
      if (!first) return countResult(0);
      yield* Effect.try({
        try: () =>
          parent.webContents.startDrag({
            file: first,
            files: cached.batch.files,
            icon: nativeImage.createFromDataURL(
              "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
            ),
          }),
        catch: deviceFailure,
      });
      return countResult(cached.batch.files.length);
    }
    if (request.action === "share" && process.platform !== "darwin")
      return yield* new DeviceError({ message: "Attachment sharing is available on macOS" });
    if (
      request.action === "openWith" &&
      (process.platform !== "darwin" || request.paths.length !== 1)
    )
      return yield* new DeviceError({
        message: "Choose one attachment on macOS to open with an application.",
      });
    if (request.action === "open" || request.action === "openWith") {
      const parts = yield* resolve(m, request);
      if (parent?.isDestroyed())
        return yield* new DeviceError({ message: "Attachment window is closed" });
      const opened = yield* openedCopies(m, request, parts);
      if (request.action === "open")
        return yield* openFiles(opened.files).pipe(Effect.tapError(() => opened.discard));
      const application = request.application;
      return yield* Effect.gen(function* () {
        const file = opened.files[0];
        if (!file) return countResult(0);
        // The renderer names an app from AttachmentApps; it must still be registered for this file.
        if (!application || !(yield* registeredAttachmentApps(file)).includes(application))
          return yield* new DeviceError({
            message: "No application is registered for this file type.",
          });
        if (parent?.isDestroyed())
          return yield* new DeviceError({ message: "Attachment window is closed" });
        yield* openAttachmentWith(application, file);
        return countResult(1);
      }).pipe(Effect.tapError(() => opened.discard));
    }
    const batch = yield* temporary(yield* resolve(m, request), keyOf(request));
    const files = batch.files;
    if (parent?.isDestroyed()) {
      yield* remove(batch);
      return yield* new DeviceError({ message: "Attachment window is closed" });
    }
    switch (request.action) {
      case "preview": {
        const first = files[0];
        if (process.platform === "darwin" && parent && first) {
          const previewed = yield* Effect.try({
            try: () => previewFile(parent, first),
            catch: deviceFailure,
          }).pipe(Effect.result);
          if (previewed._tag === "Success") {
            // Quick Look holds the file now; it expires with the batch but stops counting.
            attachmentTemp(app).release(batch);
            return countResult(1);
          }
        }
        // No Quick Look: the default app opens the temporary copy.
        return yield* openFiles(files);
      }
      case "share":
        yield* Effect.try({
          try: () => new ShareMenu({ filePaths: files }).popup(parent ? { window: parent } : {}),
          catch: deviceFailure,
        });
        return countResult(files.length);
      case "copy":
        yield* Effect.tryPromise({
          try: () =>
            clipboard.write([
              new ClipboardItem({
                "text/uri-list": files.map((file) => pathToFileURL(file).href).join("\r\n"),
              }),
            ]),
          catch: deviceFailure,
        });
        return countResult(files.length);
      default: {
        const exhaustive: never = request.action;
        return exhaustive;
      }
    }
  },
);

/** Size and edited count of the internal opened-attachments folder, for Settings. */
export const openedAttachmentsUsage = () =>
  Effect.tryPromise({ try: () => openedAttachments(app).usage(), catch: deviceFailure });

/** Settings > Local cache: deletes every internal opened copy, edited ones included. */
export const clearOpenedAttachments = () =>
  Effect.tryPromise({ try: () => openedAttachments(app).clear(), catch: deviceFailure });

/**
 * After an account is removed: deletes its opened copies that are still as written. Edited
 * copies stay where the person saved them; the removal dialog says so.
 */
export const removeAccountOpenedAttachments = (accountId: string) =>
  Effect.tryPromise({
    try: () => openedAttachments(app).removeAccount(accountId),
    catch: deviceFailure,
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("attachment-cleanup-failed", "Opened attachment cleanup failed", cause),
    ),
  );
