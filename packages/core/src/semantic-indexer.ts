import { messageModelText } from "./visible-text.js";
import { makeDownloadBudget } from "./download-budget.js";
import { Clock, Effect, Option, Semaphore } from "effect";
import type { IndexerInput } from "./indexer.js";
import { MediaError, type ModelRuntime, type VectorItem } from "./media.js";
import type { Store } from "./services.js";
import { textChunks } from "./text-chunks.js";

export const makeSemanticIndexer = Effect.fn("makeSemanticIndexer")(function* (
  input: IndexerInput,
  store: Store["Service"],
  models: ModelRuntime,
) {
  const semantic = store.semantics;
  const lock = yield* Semaphore.make(1);
  let retryAt = 0;
  const reserve = input.reserveBytes ?? (yield* makeDownloadBudget);
  const allowed = Effect.gen(function* () {
    return (
      semantic.vectors &&
      (yield* semantic.enabled) &&
      !(yield* input.store.paused) &&
      !input.onBattery() &&
      !(yield* input.busy)
    );
  });
  const beforeCpu = Effect.gen(function* () {
    while (yield* input.busy) yield* Effect.sleep("1 second");
    if (!(yield* allowed)) return yield* new MediaError({ message: "Indexing suspended" });
    return yield* Effect.void;
  });
  const passage = Effect.fnUntraced(function* (
    provenance: VectorItem["provenance"],
    items: VectorItem[],
  ) {
    yield* beforeCpu;
    items.push({
      kind: "text",
      provenance,
      vector: yield* models.embedder.text(provenance.text, "passage"),
    });
  });
  const batch = () =>
    lock.withPermit(
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) < retryAt || !(yield* allowed)) return 0;
        // Downloads contain only fixed model files. This stage never receives mail.
        const downloadMonitor = Effect.gen(function* () {
          for (;;) {
            yield* Effect.sleep("1 second");
            if ((yield* input.store.paused) || !(yield* semantic.enabled) || input.onBattery())
              return yield* new MediaError({ message: "Indexing suspended" });
          }
        });
        const prepared = yield* Effect.raceFirst(models.ensure(true), downloadMonitor).pipe(
          Effect.result,
        );
        if (prepared._tag === "Failure") {
          if (prepared.failure.message !== "Indexing suspended")
            retryAt = (yield* Clock.currentTimeMillis) + 60_000;
          return 0;
        }
        yield* semantic.repairMissingVectors;
        let completed = 0;
        for (let batchIndex = 0; batchIndex < 2; batchIndex++) {
          if ((yield* Clock.currentTimeMillis) < retryAt || !(yield* allowed)) break;
          const job = yield* semantic.claim(models.version, Date.now(), true);
          if (Option.isNone(job)) break;
          const process = Effect.gen(function* () {
            const message = yield* input.message(job.value.message_id);
            const items: VectorItem[] = [];
            for (const chunk of textChunks(
              messageModelText(message.bodyText, message.bodyHtml).text,
              256,
            ))
              yield* passage(
                {
                  messageId: message.id,
                  text: chunk.text,
                  source: { kind: "body", name: "", start: chunk.start, end: chunk.end },
                  page: null,
                  region: null,
                  visionRevision: null,
                  pipelineVersion: models.version,
                },
                items,
              );
            const derived = yield* input.store.chunks(message.id);
            for (const chunk of derived)
              for (const part of textChunks(chunk.text))
                yield* passage(
                  { ...chunk, text: part.text, pipelineVersion: models.version },
                  items,
                );
            const image = Effect.fnUntraced(function* (
              source: VectorItem["provenance"]["source"],
              data: Uint8Array,
            ) {
              yield* beforeCpu;
              const extracted = yield* models.images.image(data);
              const text =
                derived
                  .filter((chunk) =>
                    source.kind === "attachment" && chunk.source.kind === "attachment"
                      ? source.index === chunk.source.index
                      : source.kind === "inline" &&
                        chunk.source.kind === "inline" &&
                        source.cid === chunk.source.cid,
                  )
                  .map((chunk) => chunk.text)
                  .join("\n")
                  .slice(0, 1000) || source.name;
              for (const result of extracted)
                items.push({
                  kind: "image",
                  vector: result.vector,
                  provenance: {
                    messageId: message.id,
                    text,
                    source,
                    page: null,
                    region: result.region,
                    visionRevision: null,
                    pipelineVersion: models.version,
                  },
                });
            });
            for (const [index, part] of message.attachments.entries())
              if (
                part.mimeType.toLowerCase().startsWith("image/") &&
                part.size <= 32 * 1024 * 1024
              ) {
                yield* beforeCpu;
                yield* reserve(part.size > 0 ? part.size : 32 * 1024 * 1024);
                const data = yield* input.attachment(message.id, index);
                if (data.length <= 32 * 1024 * 1024)
                  yield* image(
                    { kind: "attachment", index, name: part.filename, mimeType: part.mimeType },
                    data,
                  );
              }
            if (/cid:/i.test(message.bodyHtml)) {
              yield* reserve(8 * 1024 * 1024);
              for (const inline of yield* input.inline(message.id))
                yield* image(
                  { kind: "inline", cid: inline.cid, name: inline.name, mimeType: inline.mimeType },
                  inline.data,
                );
            }
            if ((yield* input.store.paused) || !(yield* semantic.enabled))
              yield* new MediaError({ message: "Indexing suspended" });
            if (yield* semantic.complete(job.value, items, models.version)) {
              completed++;
              yield* input.changed;
            }
          });
          const monitor = Effect.gen(function* () {
            let ticks = 0;
            for (;;) {
              yield* Effect.sleep("1 second");
              if (input.onBattery() || (yield* input.store.paused) || !(yield* semantic.enabled))
                return yield* new MediaError({ message: "Indexing suspended" });
              if (++ticks % 30 === 0) yield* semantic.renew(job.value, Date.now());
            }
          });
          yield* Effect.raceFirst(process, monitor).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (error._tag === "InferenceRuntimeError") {
                  retryAt = (yield* Clock.currentTimeMillis) + 60_000;
                  yield* semantic.release(job.value, Date.now() + 60_000);
                } else if (error._tag === "AuthError" || error._tag === "ProviderError")
                  yield* semantic.deferFetch(job.value, Date.now(), error._tag === "AuthError");
                else if (error.message === "Indexing suspended") yield* semantic.release(job.value);
                else yield* semantic.retry(job.value, Date.now());
              }),
            ),
            Effect.onInterrupt(() => semantic.release(job.value)),
          );
        }
        return completed;
      }),
    );
  return { allowed, batch };
});
