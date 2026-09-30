import type { AuthError, ProviderError, PermanentError, NotFound } from "./errors.js";
import { Clock, Context, Effect, Option, Semaphore } from "effect";
import type { Message } from "./domain.js";
import {
  DerivedChunk,
  IndexingProgress,
  MEDIA_PIPELINE_VERSION,
  MediaError,
  type Vision,
} from "./media.js";
import { pdfText } from "./pdf-text.js";
import type { makeMediaStore } from "./store-media.js";

export class Indexer extends Context.Service<
  Indexer,
  {
    readonly progress: Effect.Effect<IndexingProgress>;
    setPaused(value: boolean): Effect.Effect<void>;
    /** One idle batch. Image OCR only runs on AC; PDF text runs one job on battery. */
    batch(): Effect.Effect<number>;
  }
>()("openmail/Indexer") {}

export interface IndexerInput {
  readonly store: ReturnType<typeof makeMediaStore>;
  readonly vision: Vision;
  readonly onBattery: () => boolean;
  readonly busy: Effect.Effect<boolean>;
  readonly message: (id: string) => Effect.Effect<Message>;
  readonly attachment: (
    id: string,
    index: number,
  ) => Effect.Effect<
    Uint8Array,
    MediaError | AuthError | ProviderError | PermanentError | NotFound
  >;
  readonly inline: (
    id: string,
  ) => Effect.Effect<
    readonly { cid: string; name: string; mimeType: string; data: Uint8Array }[],
    MediaError | AuthError | ProviderError | PermanentError | NotFound
  >;
  readonly changed: Effect.Effect<unknown>;
}
export const makeIndexer = Effect.fn("makeIndexer")(function* (input: IndexerInput) {
  const { store, vision } = input;
  const version = `${MEDIA_PIPELINE_VERSION}:${vision.version}`;
  const lock = yield* Semaphore.make(1);
  const allowed = Effect.gen(function* () {
    return vision.available && !(yield* store.paused) && !(yield* input.busy);
  });
  // A per-process byte budget limits historical backfill to 32 MiB/minute.
  let windowStart = yield* Clock.currentTimeMillis;
  let downloaded = 0;
  const reserve = Effect.fnUntraced(function* (bytes: number) {
    const charge = Math.min(Math.max(bytes, 1), 32 * 1024 * 1024);
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now - windowStart >= 60_000) {
        windowStart = now;
        downloaded = 0;
      }
      if (downloaded + charge <= 32 * 1024 * 1024) {
        downloaded += charge;
        return;
      }
      yield* Effect.sleep("1 second");
    }
  });
  const beforeCpu = Effect.gen(function* () {
    // Keep downloaded bytes in the current job while user activity or sync
    // prevents the next CPU stage; neither event aborts the whole job.
    while (yield* input.busy) yield* Effect.sleep("1 second");
    if (!(yield* allowed)) return yield* new MediaError({ message: "Indexing suspended" });
    return yield* Effect.void;
  });
  const extract = Effect.fnUntraced(function* (message: Message) {
    const chunks: DerivedChunk[] = [];
    let scanned = false;
    const image = Effect.fnUntraced(function* (source: DerivedChunk["source"], data: Uint8Array) {
      if (input.onBattery() || (yield* store.paused))
        return yield* new MediaError({ message: "Indexing suspended" });
      yield* beforeCpu;
      const result = yield* vision.recognize(data);
      for (const line of result.lines)
        if (line.text.trim())
          chunks.push({
            messageId: message.id,
            text: line.text,
            source,
            page: null,
            region: line.region,
            pipelineVersion: version,
            visionRevision: result.revision,
          });
      return yield* Effect.void;
    });
    for (const [index, attachment] of message.attachments.entries()) {
      const mimeType = attachment.mimeType.toLowerCase();
      if (!mimeType.startsWith("image/") && mimeType !== "application/pdf") continue;
      if (attachment.size > 32 * 1024 * 1024) {
        scanned = true;
        continue;
      }
      yield* beforeCpu;
      yield* reserve(attachment.size > 0 ? attachment.size : 32 * 1024 * 1024);
      const data = yield* input.attachment(message.id, index);
      if (data.length > 32 * 1024 * 1024) {
        scanned = true;
        continue;
      }
      const source = { kind: "attachment", index, name: attachment.filename, mimeType } as const;
      if (mimeType.startsWith("image/")) yield* image(source, data);
      else {
        yield* beforeCpu;
        for (const page of yield* pdfText(data)) {
          if (!page.text) {
            scanned = true;
            continue;
          }
          for (let start = 0; start < page.text.length; start += 900)
            chunks.push({
              messageId: message.id,
              text: page.text.slice(start, start + 1000),
              source,
              page: page.page,
              region: null,
              pipelineVersion: version,
              visionRevision: null,
            });
        }
      }
    }
    if (/cid:/i.test(message.bodyHtml)) {
      yield* reserve(8 * 1024 * 1024);
      for (const inline of yield* input.inline(message.id)) {
        yield* image(
          { kind: "inline", cid: inline.cid, name: inline.name, mimeType: inline.mimeType },
          inline.data,
        );
      }
    }
    return {
      chunks,
      note: scanned ? "Scanned PDF pages or oversized attachments require phase 2" : null,
    };
  });
  return Indexer.of({
    progress: Effect.gen(function* () {
      return {
        ...(yield* store.counts),
        available: vision.available,
        paused: yield* store.paused,
        onBattery: input.onBattery(),
        pipelineVersion: version,
      };
    }),
    setPaused: store.setPaused,
    batch: () =>
      lock.withPermit(
        Effect.gen(function* () {
          let completed = 0;
          for (let i = 0; i < (input.onBattery() ? 1 : 3); i++) {
            if (!(yield* allowed)) break;
            const job = yield* store.claim(version, Date.now(), !input.onBattery());
            if (Option.isNone(job)) break;
            yield* Effect.gen(function* () {
              const message = yield* input.message(job.value.message_id);
              const imageWork =
                /cid:/i.test(message.bodyHtml) ||
                message.attachments.some((part) =>
                  part.mimeType.toLowerCase().startsWith("image/"),
                );
              const monitor = Effect.gen(function* () {
                let ticks = 0;
                for (;;) {
                  yield* Effect.sleep("1 second");
                  if ((yield* store.paused) || (imageWork && input.onBattery()))
                    return yield* new MediaError({ message: "Indexing suspended" });
                  if (++ticks % 30 === 0) yield* store.renew(job.value, Date.now());
                }
              });
              const result = yield* Effect.raceFirst(extract(message), monitor);
              if (
                (yield* store.paused) ||
                (input.onBattery() && result.chunks.some((chunk) => chunk.region !== null))
              ) {
                yield* store.release(job.value);
                return;
              }
              if (yield* store.complete(job.value, result.chunks, result.note)) {
                completed++;
                yield* input.changed;
              }
            }).pipe(
              Effect.catch((error) =>
                error._tag === "AuthError" || error._tag === "ProviderError"
                  ? store
                      .deferFetch(job.value, Date.now(), error._tag === "AuthError")
                      .pipe(Effect.tap(() => input.changed))
                  : error.message === "Indexing suspended"
                    ? store.release(job.value)
                    : store.retry(job.value, Date.now()),
              ),
              Effect.onInterrupt(() => store.release(job.value)),
            );
          }
          return completed;
        }),
      ),
  });
});
