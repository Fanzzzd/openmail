/** Browser-style attachment downloads: saves go straight to the attachment folder, no dialog. */
import { randomUUID } from "node:crypto";
import { open, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { DeviceError } from "@openmail/core";
import { Effect } from "effect";
import { constVoid } from "effect/Function";

import { activeDownload, type DownloadCommand, type DownloadItem } from "../../shared/downloads";
import { launcherBlockedMessage, safeFilename } from "./attachment-filenames";

export interface DownloadSource {
  messageId: string;
  path: readonly number[];
  /** Shown until the content arrives. */
  filename: string;
  size: number;
}
export interface DownloadContent {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}
export interface DownloadDeps {
  fetch: (source: DownloadSource) => Effect.Effect<DownloadContent, unknown>;
  /** Files that run code: saving is allowed, opening from the app is not. */
  blocked: (file: { filename: string; mimeType: string }) => boolean;
  quarantine: (file: string) => Effect.Effect<void>;
  /** Resolves to an error message, or "" on success (Electron's shell.openPath). */
  openPath: (file: string) => Promise<string>;
  showItem: (file: string) => void;
  run: (effect: Effect.Effect<void>) => void;
  now?: () => number;
  chunkBytes?: number;
  /** Progress events are coalesced to at most one per interval. */
  progressMs?: number;
}

interface Entry {
  item: DownloadItem;
  source: DownloadSource;
  folder: string;
  file?: string;
  attempt: symbol;
}

const MAX_ENTRIES = 100;
/** Attachments fetched at once; the rest wait their turn. */
const MAX_CONCURRENT = 4;
const MAX_DUPLICATES = 10_000;

/** "name.ext", then "name (2).ext" and so on. Never overwrites: the name is reserved with O_EXCL. */
export async function writeUnique(
  folder: string,
  name: string,
  data: Uint8Array,
  onProgress: (bytes: number) => void = constVoid,
  chunkBytes = 256 * 1024,
): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n <= MAX_DUPLICATES; n++) {
    const target = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(target, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
    try {
      for (let offset = 0; offset < data.byteLength;) {
        const { bytesWritten } = await handle.write(
          data,
          offset,
          Math.min(chunkBytes, data.byteLength - offset),
        );
        offset += bytesWritten;
        onProgress(offset);
      }
      await handle.close();
      return target;
    } catch (error) {
      await handle.close().catch(constVoid);
      await unlink(target).catch(constVoid);
      throw error;
    }
  }
  throw new Error("Too many duplicate filenames");
}

const isFile = (file: string) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

export function createDownloads(deps: DownloadDeps) {
  const now = deps.now ?? Date.now;
  const entries: Entry[] = [];
  const listeners = new Set<(items: readonly DownloadItem[]) => void>();
  let lastProgress = 0;
  const waiting: (() => void)[] = [];
  let running = 0;
  const pump = () => {
    while (running < MAX_CONCURRENT) {
      const job = waiting.shift();
      if (!job) return;
      running++;
      job();
    }
  };
  const release = Effect.sync(() => {
    running--;
    pump();
  });

  const list = (): readonly DownloadItem[] => entries.map((entry) => entry.item);
  const emit = () => {
    const items = list();
    for (const listener of listeners) listener(items);
  };
  const current = (entry: Entry, attempt: symbol) =>
    entry.attempt === attempt && entries.includes(entry);
  const update = (entry: Entry, patch: Partial<DownloadItem>) => {
    entry.item = { ...entry.item, ...patch };
  };
  const trim = () => {
    while (entries.length > MAX_ENTRIES) {
      const index = entries.findLastIndex((entry) => !activeDownload(entry.item));
      if (index < 0) break;
      entries.splice(index, 1);
    }
  };

  const download = (entry: Entry) => {
    const attempt = Symbol();
    entry.attempt = attempt;
    delete entry.file;
    const { failure: _failure, ...rest } = entry.item;
    entry.item = {
      ...rest,
      filename: safeFilename(entry.source.filename),
      size: entry.source.size,
      received: 0,
      status: "fetching",
      startedAt: now(),
    };
    waiting.push(() =>
      deps.run(
        Effect.gen(function* () {
          // Removed or retried while it waited.
          if (!current(entry, attempt)) return;
          const content = yield* deps
            .fetch(entry.source)
            .pipe(Effect.mapError(() => "fetch" as const));
          if (!current(entry, attempt)) return;
          const name = safeFilename(content.filename);
          update(entry, {
            filename: name,
            size: content.data.byteLength,
            status: "writing",
            blocked: deps.blocked({ filename: name, mimeType: content.mimeType }),
          });
          emit();
          const file = yield* Effect.tryPromise({
            try: () =>
              writeUnique(
                entry.folder,
                name,
                content.data,
                (received) => {
                  if (!current(entry, attempt)) return;
                  update(entry, { received });
                  const at = now();
                  if (at - lastProgress >= (deps.progressMs ?? 100)) {
                    lastProgress = at;
                    emit();
                  }
                },
                deps.chunkBytes,
              ),
            catch: () => "write" as const,
          });
          yield* deps.quarantine(file);
          if (!current(entry, attempt)) return;
          entry.file = file;
          update(entry, {
            filename: path.basename(file),
            received: content.data.byteLength,
            status: "done",
          });
          emit();
        }).pipe(
          Effect.catch((failure) =>
            Effect.sync(() => {
              if (!current(entry, attempt)) return;
              update(entry, { status: "failed", failure });
              emit();
            }),
          ),
          Effect.ensuring(release),
        ),
      ),
    );
    pump();
  };

  const find = (id: string) => {
    const entry = entries.find((candidate) => candidate.item.id === id);
    return entry ? Effect.succeed(entry) : Effect.fail(new DeviceError({ message: "No download" }));
  };
  /** The saved file, or a failure that also marks the row as moved or deleted. */
  const savedFile = (entry: Entry) =>
    Effect.gen(function* () {
      const file = entry.file;
      if (entry.item.status !== "done" || !file)
        return yield* new DeviceError({ message: "The download has not finished" });
      if (!(yield* Effect.promise(() => isFile(file)))) {
        update(entry, { failure: "missing" });
        emit();
        return yield* new DeviceError({ message: "The file was moved or deleted" });
      }
      return file;
    });

  return {
    list,
    subscribe(listener: (items: readonly DownloadItem[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Queues the sources into `folder`. Returns how many were queued. */
    start(sources: readonly DownloadSource[], folder: string) {
      for (const source of sources) {
        // download() fills in the rest of the row.
        const entry: Entry = {
          item: {
            id: randomUUID(),
            filename: "",
            size: 0,
            received: 0,
            status: "fetching",
            blocked: false,
            startedAt: 0,
          },
          source,
          folder,
          attempt: Symbol(),
        };
        entries.unshift(entry);
        download(entry);
      }
      trim();
      emit();
      return sources.length;
    },
    command: (id: string, command: DownloadCommand) =>
      Effect.gen(function* () {
        const entry = yield* find(id);
        switch (command) {
          case "open": {
            if (entry.item.blocked)
              return yield* new DeviceError({
                message: launcherBlockedMessage(entry.item.filename),
              });
            const file = yield* savedFile(entry);
            const error = yield* Effect.promise(() => deps.openPath(file));
            if (error) return yield* new DeviceError({ message: error });
            break;
          }
          case "show":
            deps.showItem(yield* savedFile(entry));
            break;
          case "retry":
            if (entry.item.status !== "failed" && entry.item.failure !== "missing")
              return yield* new DeviceError({ message: "Only failed downloads can be retried" });
            download(entry);
            emit();
            break;
          case "remove":
            if (activeDownload(entry.item)) break;
            entries.splice(entries.indexOf(entry), 1);
            emit();
            break;
        }
        return yield* Effect.void;
      }),
    clear() {
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (entry && !activeDownload(entry.item)) entries.splice(index, 1);
      }
      emit();
    },
  };
}
export type Downloads = ReturnType<typeof createDownloads>;
