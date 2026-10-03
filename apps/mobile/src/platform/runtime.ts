import {
  ImageNetwork,
  mobileMailCodecLayer,
  MediaError,
  PdfWorker,
  ProviderError,
} from "@openmail/core/portable";
import { Effect, Layer } from "effect";

import { attachmentFilesLayer } from "./attachment-cache";

// MIME and attachment cache are portable; media extraction still needs a native worker.
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
  attachmentFilesLayer,
);
