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
  page: Schema.NullOr(Schema.Int),
  region: Schema.NullOr(ImageRegion),
  pipelineVersion: Schema.String,
  visionRevision: Schema.NullOr(Schema.Int),
});
export type DerivedChunk = typeof DerivedChunk.Type;
export const IndexingProgress = Schema.Struct({
  available: Schema.Boolean,
  paused: Schema.Boolean,
  onBattery: Schema.Boolean,
  queued: Schema.Number,
  running: Schema.Number,
  done: Schema.Number,
  failed: Schema.Number,
  pipelineVersion: Schema.String,
});
export type IndexingProgress = typeof IndexingProgress.Type;
export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  message: Schema.String,
}) {}
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
}
export const unavailableVision: Vision = {
  available: false,
  version: "unavailable",
  recognize: () => Effect.succeed({ revision: 0, lines: [] }),
};
export const MEDIA_PIPELINE_VERSION = "media-1:tile1024-overlap128:pdf-text2-worker";
