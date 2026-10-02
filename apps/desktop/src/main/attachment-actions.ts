import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import {
  app,
  clipboard,
  ClipboardItem,
  dialog,
  nativeImage,
  ShareMenu,
  shell,
  type BrowserWindow,
} from "electron";
import {
  DeviceError,
  deviceErrorReason,
  type AttachmentAction,
  type AttachmentActionResult,
  type Mailbox,
  type PerformError,
} from "@openmail/core";
import { attachmentTemp, type TempBatch } from "./attachment-temp";
import { EXECUTABLE, safeFilename } from "./attachment-filenames";
import { quarantine } from "./file-quarantine";

type Request = {
  messageId: string;
  paths: readonly (readonly number[])[];
  action: AttachmentAction;
  listId?: string;
};
type DragRequest = Pick<Request, "messageId" | "paths" | "listId">;
type Prepared =
  | { kind: "loading"; token: symbol }
  | { kind: "ready"; token: symbol; key: string; batch: TempBatch; expires: number };
const failed = (error: unknown) => new DeviceError({ message: deviceErrorReason(error) });
const keyOf = (request: DragRequest) => JSON.stringify([request.messageId, request.paths]);
const prepared = new WeakMap<BrowserWindow, Map<string, Prepared>>();
const slotOf = (request: { messageId: string; listId?: string }) =>
  request.listId ?? request.messageId;
const countResult = (count: number): AttachmentActionResult => ({ count, failures: [] });
const blocked = (parts: readonly { filename: string }[]) => {
  const file = parts.find((part) => EXECUTABLE.test(safeFilename(part.filename)));
  return file
    ? Effect.fail(
        new DeviceError({
          message: `${safeFilename(file.filename)} can run code. Save it and open it yourself if you trust it.`,
        }),
      )
    : Effect.void;
};
const resolve = Effect.fnUntraced(function* (m: Mailbox["Service"], request: DragRequest) {
  const resolved = yield* m.attachmentParts(request.messageId, request.paths);
  const parts: Effect.Success<ReturnType<Mailbox["Service"]["attachmentPart"]>>[] = [];
  for (const part of resolved) {
    if (part.kind === "failed") return yield* part.error;
    parts.push(part.content);
  }
  yield* blocked(parts);
  return parts;
});
const temporary = Effect.fnUntraced(function* (
  parts: readonly { filename: string; data: Uint8Array }[],
) {
  const batch = yield* Effect.tryPromise({
    try: () => attachmentTemp(app).writeBatch(parts),
    catch: failed,
  });
  for (const file of batch.files) yield* quarantine(file);
  return batch;
});
const remove = (batch: TempBatch) =>
  Effect.tryPromise({ try: () => attachmentTemp(app).remove(batch), catch: failed });

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
              Effect.runSync(Effect.logWarning("Attachment drag cleanup failed", error));
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
  const batch = yield* temporary(parts);
  if (parent.isDestroyed() || slots.get(slotId)?.token !== token) yield* remove(batch);
  else
    slots.set(slotId, { kind: "ready", token, key, batch, expires: Date.now() + 25 * 60 * 1000 });
  return yield* Effect.void;
});

const save = Effect.fnUntraced(function* (
  m: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: Request,
): Effect.fn.Return<AttachmentActionResult, PerformError | DeviceError> {
  const options = {
    defaultPath: app.getPath("downloads"),
    properties: ["openDirectory", "createDirectory"] satisfies (
      | "openDirectory"
      | "createDirectory"
    )[],
  };
  const choice = yield* Effect.tryPromise({
    try: () => (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)),
    catch: failed,
  });
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder) return countResult(0);
  const resolved = yield* m.attachmentParts(request.messageId, request.paths);
  const failures: { path: readonly number[]; filename: string; reason: string }[] = [];
  let count = 0;
  for (const entry of resolved) {
    if (entry.kind === "failed") {
      failures.push({
        path: entry.path,
        filename: safeFilename(entry.filename),
        reason: deviceErrorReason(entry.error),
      });
      continue;
    }
    const filename = safeFilename(entry.content.filename);
    const written = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(folder, { recursive: true });
        const ext = path.extname(filename);
        const stem = filename.slice(0, filename.length - ext.length);
        for (let n = 1; n <= 10000; n++) {
          const target = path.join(folder, n === 1 ? filename : `${stem} (${n})${ext}`);
          try {
            await writeFile(target, entry.content.data, { flag: "wx", mode: 0o600 });
            return target;
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST")
              throw error;
          }
        }
        throw new Error("Too many duplicate filenames");
      },
      catch: failed,
    }).pipe(
      Effect.flatMap((file) => quarantine(file).pipe(Effect.as(file))),
      Effect.result,
    );
    if (written._tag === "Failure")
      failures.push({ path: entry.path, filename, reason: written.failure.message });
    else count++;
  }
  return { count, failures };
});

/** Only Save exports launchers. Open, preview, sharing, copy and drag all use
 * the same block before any file is passed to another app or native menu. */
export const attachmentAction: (
  m: Mailbox["Service"],
  parent: BrowserWindow | null,
  request: Request,
) => Effect.Effect<AttachmentActionResult, PerformError | DeviceError> = Effect.fnUntraced(
  function* (m: Mailbox["Service"], parent: BrowserWindow | null, request: Request) {
    if (request.action === "save") return yield* save(m, parent, request);
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
        catch: failed,
      });
      return countResult(cached.batch.files.length);
    }
    if (request.action === "share" && process.platform !== "darwin")
      return yield* new DeviceError({ message: "Attachment sharing is available on macOS" });
    const batch = yield* temporary(yield* resolve(m, request));
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
            try: () => parent.previewFile(first),
            catch: failed,
          }).pipe(Effect.result);
          if (previewed._tag === "Success") return countResult(1);
        }
        break;
      }
      case "share":
        yield* Effect.try({
          try: () => new ShareMenu({ filePaths: files }).popup(parent ? { window: parent } : {}),
          catch: failed,
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
          catch: failed,
        });
        return countResult(files.length);
      case "open":
        break;
      default: {
        const exhaustive: never = request.action;
        return exhaustive;
      }
    }
    for (const file of files) {
      yield* Effect.tryPromise({ try: () => stat(file), catch: failed });
      const error = yield* Effect.tryPromise({ try: () => shell.openPath(file), catch: failed });
      if (error) return yield* new DeviceError({ message: error });
    }
    return countResult(files.length);
  },
);
