import { Worker } from "node:worker_threads";
import { Effect, Schema } from "effect";
import { MediaError } from "./media.js";

const Result = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    pages: Schema.Array(
      Schema.Struct({
        page: Schema.Int,
        text: Schema.String,
        png: Schema.optionalKey(Schema.String),
      }),
    ),
  }),
  Schema.Struct({ ok: Schema.Literal(false) }),
]);
export const PDF_LIMITS = { timeoutMs: 30_000, maxPages: 100, maxBytes: 32 * 1024 * 1024 } as const;
interface PdfOptions {
  readonly timeoutMs?: number;
  readonly maxPages?: number;
  readonly renderPage?: number;
  /** Allows a different local worker entry, including deterministic watchdog fixtures. */
  readonly workerUrl?: URL;
}
/** Every PDF runs in a disposable worker. Terminate on timeout, abort, error or success. */
export const pdfText = (data: Uint8Array, options: PdfOptions = {}) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<readonly { page: number; text: string; png?: string }[]>((resolve, reject) => {
        if (data.length > PDF_LIMITS.maxBytes) {
          reject(new Error("PDF size limit exceeded"));
          return;
        }
        const copy = new Uint8Array(data);
        const worker = new Worker(
          options.workerUrl ?? new URL("./pdf-worker.mjs", import.meta.url),
          {
            workerData: {
              data: copy.buffer,
              maxPages: options.maxPages ?? PDF_LIMITS.maxPages,
              renderPage: options.renderPage ?? 0,
            },
            transferList: [copy.buffer],
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
          },
        );
        let settled = false;
        const finish = (
          pages: readonly { page: number; text: string; png?: string }[] | undefined,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          void worker.terminate().then(() => {
            return pages
              ? resolve(pages)
              : reject(new Error("PDF worker failed or exceeded limits"));
          }, reject);
        };
        const abort = () => finish(undefined);
        const timer = setTimeout(abort, options.timeoutMs ?? PDF_LIMITS.timeoutMs);
        signal.addEventListener("abort", abort, { once: true });
        worker.once("message", (message: unknown) => {
          try {
            const result = Schema.decodeUnknownSync(Result)(message);
            finish(result.ok ? result.pages : undefined);
          } catch {
            finish(undefined);
          }
        });
        worker.once("error", abort);
        worker.once("exit", () => {
          if (!settled) abort();
        });
        if (signal.aborted) abort();
      }),
    catch: () => new MediaError({ message: "Cannot extract PDF text within resource limits" }),
  });
