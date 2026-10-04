import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Semaphore, Schema } from "effect";
import {
  EmbeddedImage,
  MediaError,
  InferenceRuntimeError,
  type InferenceError,
  type ModelRuntime,
  type ModelsStatus,
} from "../../media.js";
import { modelFiles } from "./model-downloads.js";
import { MODEL_BYTES, MODEL_VERSION } from "../../model-manifest.js";
import {
  nodeInferenceProcess,
  type InferenceProcess,
  type InferenceProcessLauncher,
} from "./inference-process.js";

const Reply = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), vector: Schema.Array(Schema.Number) }),
  Schema.Struct({ ok: Schema.Literal(true), images: Schema.Array(EmbeddedImage) }),
  Schema.Struct({ ok: Schema.Literal(false), reason: Schema.Literals(["load", "content"]) }),
]);
export interface NodeModelsOptions {
  readonly launch?: InferenceProcessLauncher;
  readonly idleMs?: number;
  readonly timeoutMs?: number;
  readonly prepare?: typeof modelFiles;
}
const unavailable = () =>
  new InferenceRuntimeError({ reason: "unavailable", message: "Models are not verified" });

export const makeNodeModels = Effect.fn("makeNodeModels")(function* (
  dataDirectory: string,
  localRoot?: string,
  options: NodeModelsOptions = {},
) {
  const launch = options.launch ?? nodeInferenceProcess;
  const root = localRoot ?? join(dataDirectory, "models", "v1-761b726d-757d59c9");
  let status: ModelsStatus = { kind: "disabled" };
  let verified = false;
  let child: InferenceProcess | undefined;
  let download: AbortController | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const cache = new Map<string, string>();
  const inferenceLock = yield* Semaphore.make(1);
  const downloadLock = yield* Semaphore.make(1);
  const close = async () => {
    if (idle) clearTimeout(idle);
    idle = undefined;
    const old = child;
    child = undefined;
    await old?.kill();
  };
  const stop = Effect.promise(async () => {
    download?.abort();
    await close();
    verified = false;
    status = { kind: "disabled" };
  });
  yield* Effect.addFinalizer(() => stop);
  const ensure = (allowDownload: boolean) =>
    Effect.suspend((): Effect.Effect<void, InferenceError> => {
      if (verified) return Effect.void;
      // A foreground read is never allowed to wait behind a download/hash pass.
      if (!allowDownload) return Effect.fail(unavailable());
      return downloadLock.withPermit(
        Effect.gen(function* () {
          if (verified) return;
          const abort = new AbortController();
          download = abort;
          yield* (options.prepare ?? modelFiles)(
            root,
            true,
            (state) => {
              status = state;
            },
            { signal: abort.signal, cache },
          ).pipe(
            Effect.onInterrupt(() => Effect.sync(() => abort.abort())),
            Effect.tapError(() =>
              Effect.sync(() => {
                status = {
                  kind: "error",
                  message: "Model download or verification failed",
                  bytes: status.kind === "downloading" ? status.bytes : 0,
                  total: MODEL_BYTES,
                };
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (download === abort) download = undefined;
              }),
            ),
          );
          verified = true;
          status = { kind: "ready", total: MODEL_BYTES, version: MODEL_VERSION };
        }),
      );
    });
  const verifyLocal = () =>
    downloadLock.withPermit(
      Effect.gen(function* () {
        if (verified) return;
        yield* (options.prepare ?? modelFiles)(
          root,
          false,
          (state) => {
            status = state;
          },
          { cache },
        );
        verified = true;
        status = { kind: "ready", total: MODEL_BYTES, version: MODEL_VERSION };
      }),
    );
  const run = (
    message:
      | { kind: "text"; text: string; mode: "query" | "passage" }
      | { kind: "query"; text: string }
      | { kind: "image"; data: Uint8Array },
  ) =>
    inferenceLock.withPermit(
      Effect.tryPromise({
        try: (signal) =>
          new Promise<typeof Reply.Type>((resolve, reject) => {
            if (!verified) {
              reject(unavailable());
              return;
            }
            if (idle) clearTimeout(idle);
            idle = undefined;
            child ??= launch(
              fileURLToPath(new URL("./embedding-worker.mjs", import.meta.url)),
              root,
            );
            const running = child;
            let settled = false;
            const finish = (error: Error | undefined, value?: typeof Reply.Type) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              signal.removeEventListener("abort", abort);
              offMessage();
              offFailure();
              if (error) {
                Effect.runFork(
                  Effect.promise(close).pipe(
                    Effect.catchCause(() => Effect.void),
                    Effect.andThen(Effect.sync(() => reject(error))),
                  ),
                );
              } else {
                idle = setTimeout(() => {
                  Effect.runFork(Effect.promise(close));
                }, options.idleMs ?? 30_000);
                idle.unref();
                if (value) resolve(value);
              }
            };
            const abort = () =>
              finish(
                new InferenceRuntimeError({
                  reason: "exit",
                  message: "Inference process interrupted",
                }),
              );
            const timer = setTimeout(
              () =>
                finish(
                  new InferenceRuntimeError({
                    reason: "timeout",
                    message: "Inference process timed out",
                  }),
                ),
              options.timeoutMs ?? 60_000,
            );
            const offMessage = running.onMessage((value) => {
              try {
                const result = Schema.decodeUnknownSync(Reply)(value);
                if (!result.ok)
                  finish(
                    result.reason === "load"
                      ? new InferenceRuntimeError({
                          reason: "load",
                          message: "Local model load failed",
                        })
                      : new MediaError({ message: "Cannot process this input" }),
                  );
                else finish(undefined, result);
              } catch {
                finish(
                  new InferenceRuntimeError({
                    reason: "exit",
                    message: "Invalid inference process reply",
                  }),
                );
              }
            });
            const offFailure = running.onFailure(() =>
              finish(
                new InferenceRuntimeError({ reason: "exit", message: "Inference process exited" }),
              ),
            );
            signal.addEventListener("abort", abort, { once: true });
            try {
              running.send(message);
            } catch {
              abort();
            }
            if (signal.aborted) abort();
          }),
        catch: (error) =>
          error instanceof InferenceRuntimeError || error instanceof MediaError
            ? error
            : new InferenceRuntimeError({
                reason: "exit",
                message: "Cannot start inference process",
              }),
      }),
    );
  const text = (kind: "text" | "query", value: string, mode: "query" | "passage" = "query") =>
    run(kind === "text" ? { kind, text: value, mode } : { kind, text: value }).pipe(
      Effect.flatMap((result) =>
        result.ok &&
        "vector" in result &&
        result.vector.length === (kind === "text" ? 384 : 512) &&
        result.vector.every(Number.isFinite)
          ? Effect.succeed(result.vector)
          : Effect.fail(new MediaError({ message: "Invalid on-device vector" })),
      ),
    );
  return {
    version: MODEL_VERSION,
    status: Effect.sync(() => status),
    ensure,
    verifyLocal,
    stop: () => stop,
    embedder: { version: MODEL_VERSION, text: (value, mode) => text("text", value, mode) },
    images: {
      version: MODEL_VERSION,
      query: (value) => text("query", value),
      image: (data) =>
        run({ kind: "image", data }).pipe(
          Effect.flatMap((result) =>
            result.ok &&
            "images" in result &&
            result.images.every(
              (image) => image.vector.length === 512 && image.vector.every(Number.isFinite),
            )
              ? Effect.succeed(result.images)
              : Effect.fail(new MediaError({ message: "Invalid on-device image vector" })),
          ),
        ),
    },
  } satisfies ModelRuntime;
});
