import { Effect, Schema } from "effect";

/** Pixels in the original image, with a top-left origin. */
export const ImageBox = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type ImageBox = typeof ImageBox.Type;
export const MediaSource = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("body"),
    name: Schema.String,
    start: Schema.Int,
    end: Schema.Int,
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    index: Schema.Int,
    name: Schema.String,
    mimeType: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("inline"),
    cid: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
  }),
]);
export const ImageRegion = Schema.Struct({
  box: ImageBox,
  tile: ImageBox,
  imageWidth: Schema.Number,
  imageHeight: Schema.Number,
});
export const DerivedChunk = Schema.Struct({
  messageId: Schema.String,
  text: Schema.String,
  source: MediaSource,
  /** Position within one MIME part, independent of text, page or pipeline revision. */
  chunkIndex: Schema.optionalKey(Schema.Int),
  page: Schema.NullOr(Schema.Int),
  region: Schema.NullOr(ImageRegion),
  pipelineVersion: Schema.String,
  visionRevision: Schema.NullOr(Schema.Int),
});
export type DerivedChunk = typeof DerivedChunk.Type;
export const ModelsStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({
    kind: Schema.Literal("downloading"),
    bytes: Schema.Number,
    total: Schema.Number,
    file: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("ready"), total: Schema.Number, version: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    message: Schema.String,
    bytes: Schema.Number,
    total: Schema.Number,
  }),
]);
export type ModelsStatus = typeof ModelsStatus.Type;
export const IndexingProgress = Schema.Struct({
  available: Schema.Boolean,
  paused: Schema.Boolean,
  onBattery: Schema.Boolean,
  queued: Schema.Number,
  running: Schema.Number,
  done: Schema.Number,
  failed: Schema.Number,
  pipelineVersion: Schema.String,
  /** False where on-device models cannot run (an Intel Mac); absent where they can. */
  modelsSupported: Schema.optionalKey(Schema.Boolean),
  modelsEnabled: Schema.optionalKey(Schema.Boolean),
  models: Schema.optionalKey(ModelsStatus),
  semanticAvailable: Schema.optionalKey(Schema.Boolean),
  embeddingRunning: Schema.optionalKey(Schema.Number),
  embeddingQueued: Schema.optionalKey(Schema.Number),
  embeddingDone: Schema.optionalKey(Schema.Number),
  embeddingFailed: Schema.optionalKey(Schema.Number),
});
export type IndexingProgress = typeof IndexingProgress.Type;
export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  message: Schema.String,
}) {}
export class InferenceRuntimeError extends Schema.TaggedError<InferenceRuntimeError>()(
  "InferenceRuntimeError",
  {
    reason: Schema.Literals(["load", "exit", "timeout", "unavailable"]),
    message: Schema.String,
  },
) {}
export type InferenceError = MediaError | InferenceRuntimeError;
export const VisionResult = Schema.Struct({
  revision: Schema.Int,
  lines: Schema.Array(
    Schema.Struct({ text: Schema.String, confidence: Schema.Number, region: ImageRegion }),
  ),
});
export type VisionResult = typeof VisionResult.Type;
/** Platform port. Implementations must process bytes locally and never call a model API. */
export interface Vision {
  readonly available: boolean;
  /** Include the OS Vision revision and the preprocessing version. */
  readonly version: string;
  recognize(data: Uint8Array): Effect.Effect<VisionResult, MediaError>;
  readonly imageVectors?: ImageEmbedder;
}
export const unavailableVision: Vision = {
  available: false,
  version: "unavailable",
  recognize: () => Effect.succeed({ revision: 0, lines: [] }),
};
export const MEDIA_PIPELINE_VERSION = "media-1:tile1024-overlap128:pdf-text2-worker";

export function derivedPart(source: DerivedChunk["source"]): string {
  switch (source.kind) {
    case "attachment":
      return JSON.stringify([source.kind, source.index]);
    case "inline":
      return JSON.stringify([source.kind, source.cid]);
    case "body":
      return JSON.stringify([source.kind, source.start, source.end]);
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Local inference ports. Arrays contain normalized finite float32 vectors. */
export interface Embedder {
  readonly version: string;
  text(text: string, mode: "query" | "passage"): Effect.Effect<readonly number[], InferenceError>;
}
export const EmbeddedImage = Schema.Struct({
  vector: Schema.Array(Schema.Number),
  region: ImageRegion,
});
export type EmbeddedImage = typeof EmbeddedImage.Type;
export interface ImageEmbedder {
  readonly version: string;
  query(text: string): Effect.Effect<readonly number[], InferenceError>;
  image(data: Uint8Array): Effect.Effect<readonly EmbeddedImage[], InferenceError>;
}
export interface ModelRuntime {
  readonly version: string;
  readonly status: Effect.Effect<ModelsStatus>;
  readonly embedder: Embedder;
  readonly images: ImageEmbedder;
  verifyLocal?(): Effect.Effect<void, MediaError>;
  ensure(download: boolean): Effect.Effect<void, InferenceError>;
  stop(): Effect.Effect<void>;
}
export interface VectorItem {
  readonly kind: "text" | "image";
  readonly vector: readonly number[];
  readonly provenance: DerivedChunk;
}
