import { Effect } from "effect";
import { PdfWorker, type PdfOptions } from "./platform/runtime.js";
export const PDF_LIMITS = { timeoutMs: 30_000, maxPages: 100, maxBytes: 32 * 1024 * 1024 } as const;
export const pdfText = (data: Uint8Array, options?: PdfOptions) =>
  Effect.flatMap(PdfWorker, (worker) => worker.extract(data, options));
