/**
 * What the reader does with files: saving and opening attachments, printing
 * and saving threads as PDF. Content comes from the Mailbox; this module only
 * asks where to put it and writes it.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type Mailbox,
  type PerformError,
  DeviceError,
  deviceErrorReason,
  printableThread,
} from "@openmail/core";

/** A mailbox failure, or one on this computer. */
type FileError = PerformError | DeviceError;
import { Effect } from "effect";
import { app, BrowserWindow, dialog, session, shell } from "electron";

import type { PrintHeadings } from "../shared/rpc";

type MailboxService = Mailbox["Service"];

/** Files that run code when opened. They can be saved, but not opened from the app. */
const EXECUTABLE =
  /\.(app|command|tool|sh|bash|zsh|csh|ksh|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|terminal|jar|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|lnk|reg|dll|so|dylib|py|pl|rb|php)$/i;

/** A filename that stays inside the folder it is written to. */
export function safeFilename(name: string): string {
  const base = path
    .basename(name.replaceAll("\\", "/"))
    .replace(/[/:]/g, "_")
    .replaceAll(/./gsu, (c) => (c.charCodeAt(0) < 32 ? "_" : c))
    .replace(/^\.+/, "")
    .trim();
  return base || "attachment";
}

const failed = (error: unknown) => new DeviceError({ message: deviceErrorReason(error) });

/**
 * Marks a file as downloaded from the internet, so macOS Gatekeeper checks
 * it on first open, as it does for Mail and browsers. Best effort.
 */
function quarantine(file: string): Effect.Effect<void> {
  if (process.platform !== "darwin") return Effect.void;
  const value = `0083;${Math.floor(Date.now() / 1000).toString(16)};OpenMail;`;
  return Effect.callback<void>((resume) => {
    execFile("xattr", ["-w", "com.apple.quarantine", value, file], () => resume(Effect.void));
  });
}

const write = (file: string, data: Uint8Array) =>
  Effect.tryPromise({
    try: () => writeFile(file, data),
    catch: failed,
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

export const saveAttachment: (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
  index: number,
) => Effect.Effect<boolean, FileError> = Effect.fnUntraced(function* (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
  index: number,
): Effect.fn.Return<boolean, FileError> {
  const [message] = (yield* m.thread(messageId)).filter((x) => x.id === messageId);
  const listed = message?.attachments[index];
  const name = safeFilename(listed?.filename ?? "attachment");
  const options = { defaultPath: path.join(app.getPath("downloads"), name) };
  const choice = yield* Effect.promise(() =>
    parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options),
  );
  if (choice.canceled || !choice.filePath) return false;
  const content = yield* m.attachment(messageId, index);
  yield* write(choice.filePath, content.data);
  return true;
});

export const saveAllAttachments: (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
) => Effect.Effect<number, FileError> = Effect.fnUntraced(function* (
  m: MailboxService,
  parent: BrowserWindow | null,
  messageId: string,
): Effect.fn.Return<number, FileError> {
  const [message] = (yield* m.thread(messageId)).filter((x) => x.id === messageId);
  const count = message?.attachments.length ?? 0;
  if (count === 0) return 0;
  const options = {
    defaultPath: app.getPath("downloads"),
    properties: ["openDirectory" as const, "createDirectory" as const],
  };
  const choice = yield* Effect.promise(() =>
    parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options),
  );
  const folder = choice.filePaths[0];
  if (choice.canceled || !folder) return 0;
  for (let index = 0; index < count; index++) {
    const content = yield* m.attachment(messageId, index);
    yield* write(yield* freePath(folder, safeFilename(content.filename)), content.data);
  }
  return count;
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
  if (EXECUTABLE.test(name)) {
    // Fails here; nothing below runs.
    yield* new DeviceError({
      message: `${name} can run code. Save it and open it yourself if you trust it.`,
    });
  }
  const folder = path.join(app.getPath("temp"), "openmail-attachments", randomUUID());
  yield* Effect.tryPromise({
    try: () => mkdir(folder, { recursive: true }),
    catch: failed,
  });
  const file = path.join(folder, name);
  yield* write(file, content.data);
  const error = yield* Effect.promise(() => shell.openPath(file));
  if (error) yield* new DeviceError({ message: error });
});

/**
 * A session for print windows that loads nothing but the local file it is
 * given, on top of the document's own CSP and JavaScript being off.
 */
function printSession() {
  const ses = session.fromPartition("openmail-print");
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file|data):/i.test(details.url) });
  });
  return ses;
}
let printSessionCache: Electron.Session | undefined;

export interface PrintRequest {
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

  const folder = path.join(app.getPath("temp"), "openmail-print");
  const file = path.join(folder, `${randomUUID()}.html`);
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(folder, { recursive: true });
      await writeFile(file, html);
    },
    catch: failed,
  });

  printSessionCache ??= printSession();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    title: subject,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      session: printSessionCache,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());

  return yield* Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => win.loadFile(file),
      catch: failed,
    });
    if (pdfPath) {
      const data = yield* Effect.tryPromise({
        try: () => win.webContents.printToPDF({ printBackground: true }),
        catch: failed,
      });
      yield* write(pdfPath, data);
      return true;
    }
    return yield* Effect.callback<boolean, DeviceError>((resume) => {
      win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
        // A cancelled print dialog reports "Print job canceled" or "cancelled".
        if (success || /cancel/i.test(reason)) resume(Effect.succeed(success));
        else resume(Effect.fail(new DeviceError({ message: deviceErrorReason(reason) })));
      });
    });
  }).pipe(
    Effect.ensuring(
      Effect.promise(async () => {
        if (!win.isDestroyed()) win.destroy();
        await rm(file, { force: true });
      }),
    ),
  );
});
