import {
  AttachmentFiles,
  ImageNetwork,
  mobileMailCodecLayer,
  MediaError,
  PdfWorker,
  ProviderError,
} from "@openmail/core/portable";
import { Effect, Layer } from "effect";

// MIME send is portable. Reader disk caching and media extraction remain unavailable.
export const readerCapabilitiesLayer = Layer.mergeAll(
  mobileMailCodecLayer,
  Layer.succeed(PdfWorker, {
    extract: () =>
      Effect.fail(new MediaError({ message: "PDF extraction is unavailable on mobile" })),
  }),
  Layer.succeed(ImageNetwork, {
    download: () =>
      Effect.fail(
        new ProviderError({ message: "Pinned image transport is unavailable on mobile" }),
      ),
  }),
  Layer.succeed(AttachmentFiles, {
    open: () => {
      throw new Error("Attachment disk caching is unavailable on mobile");
    },
  }),
);
