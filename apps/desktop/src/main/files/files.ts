import { attachmentImportKind } from "@openmail/core/schema";
import { configurePermissions, denyNavigation } from "../security/security";
import { WINDOW_SECURITY } from "../security/security-policy";
import { quarantine } from "../security/file-quarantine";
/**
 * What the reader does with files: saving and opening attachments, printing
 * and saving threads as PDF. Content comes from the Mailbox; this module only
 * asks where to put it and writes it.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type Mailbox,
  type PerformError,
  DeviceError,
  deviceFailure,
  printableThread,
} from "@openmail/core";

/** A mailbox failure, or one on this computer. */
type FileError = PerformError | DeviceError;
import { Effect } from "effect";
import { app, BrowserWindow, dialog, session, shell } from "electron";

import type { PrintHeadings } from "../../shared/rpc";

type MailboxService = Mailbox["Service"];

import { EXECUTABLE, launcherBlockedMessage, safeFilename } from "./attachment-filenames";
import { attachmentTemp } from "./attachment-temp";

/** A subject is text, not a path. Reserve space for the extension and preserve code points. */
function subjectFilename(subject: string): string {
  const clean = subject
    .normalize("NFC")
    .replace(/[\\/:]/g, "_")
    .replaceAll(/./gsu, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "_" : c))
    .trim()
    .replace(/^\.+/, "")
    .trim();
  let name = "";
  let bytes = 0;
  for (const character of clean) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > 200) break;
    name += character;
  }
  return name || "message";
}

const write = (file: string, data: Uint8Array) =>
  Effect.tryPromise({
    try: () => writeFile(file, data),
    catch: deviceFailure,
  }).pipe(Effect.andThen(quarantine(file)));

const exists = (file: string) =>
  Effect.promise(() =>
    stat(file).then(
      () => true,
      () => false,
    ),
  );

/** `name`, or "name (2).ext" and so on when the folder already has one. */
const freePath = Effect.fnUntraced(function* (folder: string, name: string) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(folder, name);
  for (let n = 2; yield* exists(candidate); n++) {
    candidate = path.join(folder, `${stem} (${n})${ext}`);
  }
  return candidate;
});

const writeNew = (file: string, data: Uint8Array) =>
  Effect.tryPromise({
    try: () => writeFile(file, data, { flag: "wx" }),
    catch: deviceFailure,
  }).pipe(Effect.andThen(quarantine(file)));

/** Cancellation happens before fetching MIME or creating any file. */
export const saveMessage: (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
) => Effect.Effect<boolean, FileError> = Effect.fnUntraced(function* (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
): Effect.fn.Return<boolean, FileError> {
  const message = (yield* m.thread(messageId)).find((item) => item.id === messageId);
  const options = {
    defaultPath: path.join(
      app.getPath("downloads"),
      `${subjectFilename(message?.subject ?? "")}.eml`,
    ),
    filters: [{ name: "Email", extensions: ["eml"] }],
  };
  const choice = yield* Effect.promise(() =>
    parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options),
  );
  if (choice.canceled || !choice.filePath) return false;
  yield* write(choice.filePath, yield* m.rawMessageBytes(messageId));
  return true;
});

/** Writes the attachment to its own temporary folder and opens it with the default app. */
export const openAttachment: (
  m: MailboxService,
  messageId: string,
  index: number,
) => Effect.Effect<void, FileError> = Effect.fnUntraced(function* (
  m: MailboxService,
  messageId: string,
  index: number,
): Effect.fn.Return<void, FileError> {
  const content = yield* m.attachment(messageId, index);
  const name = safeFilename(content.filename);
  if (EXECUTABLE.test(name) || attachmentImportKind(content) !== null) {
    // Fails here; nothing below runs.
    yield* new DeviceError({
      message: launcherBlockedMessage(name),
    });
  }
  const downloads = (yield* m.app.prefs).attachmentOpenFolder === "downloads";
  const files = downloads
    ? [
        yield* freePath(app.getPath("downloads"), name).pipe(
          Effect.tap((file) => writeNew(file, content.data)),
        ),
      ]
    : yield* Effect.tryPromise({
        try: () => attachmentTemp(app).write([content]),
        catch: deviceFailure,
      });
  const file = files[0];
  if (!file) return yield* new DeviceError({ message: "No attachment file" });
  yield* quarantine(file);
  const error = yield* Effect.promise(() => shell.openPath(file));
  if (error) yield* new DeviceError({ message: error });
  return yield* Effect.void;
});

/**
 * A session for print windows that loads nothing but the local file it is
 * given, on top of the document's own CSP and JavaScript being off.
 */
const printFiles = new Set<string>();
function printSession() {
  const ses = session.fromPartition("openmail-print");
  configurePermissions(ses);
  ses.setSpellCheckerEnabled(false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !printFiles.has(details.url) && !details.url.startsWith("data:") });
  });
  return ses;
}
let printSessionCache: Electron.Session | undefined;

interface PrintRequest {
  id: string;
  only?: string | undefined;
  pdf: boolean;
  headings: typeof PrintHeadings.Type;
  locale: string;
}

/** Prints the thread (or one message of it) from a hidden window, or saves it as PDF. */
export const printThread: (
  m: MailboxService,
  parent: BrowserWindow | null,
  request: PrintRequest,
) => Effect.Effect<boolean, FileError> = Effect.fnUntraced(function* (
  m: MailboxService,
  parent: BrowserWindow | null,
  request: PrintRequest,
): Effect.fn.Return<boolean, FileError> {
  const thread = yield* m.readerThread(request.id);
  const messages = request.only ? thread.filter((x) => x.id === request.only) : thread;
  const subject = messages.at(-1)?.subject || thread.at(-1)?.subject || "";

  let pdfPath: string | undefined;
  if (request.pdf) {
    const options = {
      defaultPath: path.join(app.getPath("documents"), `${safeFilename(subject || "message")}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const choice = yield* Effect.promise(() =>
      parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options),
    );
    if (choice.canceled || !choice.filePath) return false;
    pdfPath = choice.filePath;
  }

  // Inline images come along; remote ones stay out of print like they stay
  // out of the reader by default.
  const inline: Record<string, Record<string, string>> = {};
  for (const message of messages) {
    if (!/\bcid:/i.test(message.bodyHtml)) continue;
    inline[message.id] = yield* m.inlineImages(message.id).pipe(Effect.orElseSucceed(() => ({})));
  }
  const format = new Intl.DateTimeFormat(request.locale, {
    dateStyle: "full",
    timeStyle: "short",
  });
  const html = printableThread({
    subject,
    messages,
    headings: request.headings,
    formatDate: (ms) => format.format(ms),
    inline,
  });

  // mkdtemp creates a fresh 0700 folder, so a planted path cannot redirect the write.
  const folder = yield* Effect.tryPromise({
    try: () => mkdtemp(path.join(app.getPath("temp"), "openmail-print-")),
    catch: deviceFailure,
  });
  const file = path.join(folder, `${randomUUID()}.html`);
  const url = pathToFileURL(file).href;
  // Cleanup is attached before anything else can fail, including the window constructor.
  return yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => writeFile(file, html, { mode: 0o600, flag: "wx" }),
      catch: deviceFailure,
    });
    printFiles.add(url);
    printSessionCache ??= printSession();
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 1000,
      title: "OpenMail",
      webPreferences: {
        ...WINDOW_SECURITY,
        javascript: false,
        spellcheck: false,
        devTools: !app.isPackaged,
        session: printSessionCache,
      },
    });
    win.webContents.on("page-title-updated", (event) => event.preventDefault());
    denyNavigation(win.webContents);
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => win.loadFile(file),
        catch: deviceFailure,
      });
      if (pdfPath) {
        const data = yield* Effect.tryPromise({
          try: () => win.webContents.printToPDF({ printBackground: true }),
          catch: deviceFailure,
        });
        yield* write(pdfPath, data);
        return true;
      }
      return yield* Effect.callback<boolean, DeviceError>((resume) => {
        win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
          // A cancelled print dialog reports "Print job canceled" or "cancelled".
          if (success || /cancel/i.test(reason)) resume(Effect.succeed(success));
          else resume(Effect.fail(deviceFailure(reason)));
        });
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (!win.isDestroyed()) win.destroy();
        }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        printFiles.delete(url);
        await rm(folder, { recursive: true, force: true });
      }),
    ),
  );
});
