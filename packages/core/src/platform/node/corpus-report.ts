import { Schema, Record } from "effect";
import { MessageTextExplanation } from "../../visible-text-diagnostics.js";
import { Provider } from "../../domain.js";

export const CORPUS_LIMITS = {
  messageTimeoutMs: 2000,
  startupTimeoutMs: 15_000,
  maxMessageBytes: 16 * 1024 * 1024,
  samplesPerDiagnostic: 5,
  workerHeapMb: 96,
};

export const CorpusStage = Schema.Literals([
  "cache-decode",
  "mime-decode",
  "reader-sanitize",
  "visible-text",
  "model-text",
  "link-security",
  "message-security",
  "structured-events",
  "snippet-plain-text",
  "fts-tokenize",
]);
export type CorpusStage = typeof CorpusStage.Type;
export const CORPUS_STAGES = CorpusStage.literals;
export const CorpusAnomaly = Schema.Literals([
  "sanitizer-text-loss",
  "empty-visible-text",
  "budget-exceeded",
  "charset-replacements",
  "css-rule-budget",
  "oversized-html",
  "nesting-depth-limit",
  "link-display-mismatch",
  "failed-date-parse",
  "missing-message-id",
  "structured-events-found",
  "timeout",
  "message-size-limit",
]);
export type CorpusAnomaly = typeof CorpusAnomaly.Type;
export const CORPUS_ANOMALIES = CorpusAnomaly.literals;

export const ExceptionClass = Schema.Literals([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "PermanentError",
  "TimeoutError",
  "WorkerError",
  "SchemaError",
]);
export type ExceptionClass = typeof ExceptionClass.Type;
export const CORPUS_LOCATIONS: Record<CorpusStage, string> = {
  "cache-decode": "platform/node/corpus-pipeline.ts:decodeCache",
  "mime-decode": "platform/node/mail-codec.ts:nodeMailCodec.parse",
  "reader-sanitize": "reader-sanitize.ts:sanitizeReaderHtml",
  "visible-text": "visible-text.ts:visibleHtmlText",
  "model-text": "model-view.ts:modelContext",
  "link-security": "link-security.ts:linkDisplayMismatch",
  "message-security": "message-security.ts:messageSecurity",
  "structured-events": "structured-events.ts:structuredMailEvents",
  "snippet-plain-text": "platform/mime-compat.ts:withDecodedBody",
  "fts-tokenize": "platform/node/corpus-pipeline.ts:tokenizeFts",
};

export const CorpusMimeType = Schema.Literals([
  "other",
  "text/plain",
  "text/html",
  "text/calendar",
  "message/rfc822",
  "multipart/alternative",
  "multipart/mixed",
  "multipart/related",
  "multipart/signed",
  "multipart/report",
  "application/pdf",
  "application/octet-stream",
  "application/pkcs7-mime",
  "application/x-pkcs7-mime",
  "application/ms-tnef",
  "image/png",
  "image/jpeg",
  "image/gif",
]);
export type CorpusMimeType = typeof CorpusMimeType.Type;
const CorpusStructure = Schema.Struct({
  root: CorpusMimeType,
  parts: Schema.Array(CorpusMimeType).pipe(Schema.check(Schema.isMaxLength(19))),
});
const AnomalyCounts = Schema.Record(CorpusAnomaly, Schema.Int);
export const WorkerEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready") }),
  Schema.Struct({ kind: Schema.Literal("start"), stage: CorpusStage }),
  Schema.Struct({ kind: Schema.Literal("structure"), structure: CorpusStructure }),
  Schema.Struct({
    kind: Schema.Literal("stage"),
    stage: CorpusStage,
    ms: Schema.Number,
    failure: Schema.NullOr(ExceptionClass),
    anomalies: AnomalyCounts,
  }),
  Schema.Struct({ kind: Schema.Literal("explanation"), diagnostics: MessageTextExplanation }),
  Schema.Struct({ kind: Schema.Literal("done") }),
]);
export type WorkerEvent = typeof WorkerEvent.Type;

export const emptyAnomalies = (): Record<CorpusAnomaly, number> =>
  Record.fromEntries(CORPUS_ANOMALIES.map((kind) => [kind, 0] as const));

export const CorpusSample = Schema.Struct({
  hash: Schema.String,
  provider: Schema.Union([Provider, Schema.Literal("unknown")]),
  sizeBucket: Schema.Literals([
    "<16KiB",
    "16-64KiB",
    "64-256KiB",
    "256KiB-1MiB",
    "1-16MiB",
    ">16MiB",
  ]),
  // Constructed only from the MIME allowlist, never copied from a header.
  contentTypeStructure: Schema.String,
});
export type CorpusSample = typeof CorpusSample.Type;

const CorpusFailure = Schema.Struct({
  exceptionClass: Schema.mutableKey(ExceptionClass),
  location: Schema.mutableKey(Schema.String),
  count: Schema.mutableKey(Schema.Int),
  samples: Schema.mutableKey(Schema.mutable(Schema.Array(CorpusSample))),
});
export const CorpusStageReport = Schema.Struct({
  count: Schema.mutableKey(Schema.Int),
  completed: Schema.mutableKey(Schema.Int),
  failures: Schema.mutableKey(Schema.mutable(Schema.Array(CorpusFailure))),
  timeMs: Schema.mutableKey(
    Schema.Struct({ p50: Schema.Number, p95: Schema.Number, max: Schema.Number }),
  ),
  anomalies: Schema.mutableKey(AnomalyCounts),
});
export type CorpusStageReport = Omit<typeof CorpusStageReport.Type, "anomalies"> & {
  anomalies: Record<CorpusAnomaly, number>;
};
export interface CorpusReport {
  version: 2;
  processed: number;
  source: "temporary-read-only-snapshot";
  mimeSource: "reconstructed-cached-utf8";
  limits: typeof CORPUS_LIMITS;
  stages: Record<CorpusStage, CorpusStageReport>;
  anomalies: Record<CorpusAnomaly, { count: number; samples: CorpusSample[] }>;
}

export interface CorpusExplainReport {
  version: 2;
  mode: "explain";
  sample: CorpusSample;
  status: "complete" | "failed" | "timeout" | "aborted" | "size-limit";
  diagnostics: MessageTextExplanation | null;
  failures: { stage: CorpusStage; exceptionClass: ExceptionClass; location: string }[];
}

/** Fixed logarithmic histogram: percentile upper bounds within 5%, max is exact. */
export class CorpusTimings {
  private readonly bins = new Uint32Array(384);
  private count = 0;
  private maximum = 0;
  add(ms: number) {
    const value = Math.max(0, ms);
    const bin = Math.min(
      this.bins.length - 1,
      Math.ceil(Math.log1p(value / 0.001) / Math.log(1.05)),
    );
    this.bins[bin] = (this.bins[bin] ?? 0) + 1;
    this.count++;
    this.maximum = Math.max(this.maximum, value);
  }
  summary() {
    const percentile = (fraction: number) => {
      if (!this.count) return 0;
      let seen = 0;
      for (const [bin, count] of this.bins.entries()) {
        seen += count;
        if (seen >= Math.ceil(this.count * fraction))
          return Math.min(this.maximum, 0.001 * (1.05 ** bin - 1));
      }
      return this.maximum;
    };
    return { p50: percentile(0.5), p95: percentile(0.95), max: this.maximum };
  }
}

export function corpusSizeBucket(size: number): CorpusSample["sizeBucket"] {
  if (size < 16 * 1024) return "<16KiB";
  if (size < 64 * 1024) return "16-64KiB";
  if (size < 256 * 1024) return "64-256KiB";
  if (size <= 1024 * 1024) return "256KiB-1MiB";
  return size <= 16 * 1024 * 1024 ? "1-16MiB" : ">16MiB";
}
