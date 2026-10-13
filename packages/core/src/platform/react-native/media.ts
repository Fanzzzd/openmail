import { Effect, Layer } from "effect";
import { MediaError } from "../../media.js";
import { ProviderError } from "../../domain/errors.js";
import { ImageNetwork, PdfWorker } from "../runtime.js";

/** Hermes has no disposable PDF.js worker or browser DOM. Never upload PDF bytes as a fallback. */
export const mobileMediaLayer = Layer.mergeAll(
  Layer.succeed(PdfWorker, {
    extract: () =>
      Effect.fail(new MediaError({ message: "PDF extraction is unavailable on mobile" })),
  }),
  // This port is for compose URL import/contact photos, not the opt-in WebView reader.
  // Fetch cannot pin DNS and TLS across redirects. Never weaken desktop SSRF rules.
  Layer.succeed(ImageNetwork, {
    download: () =>
      Effect.fail(
        new ProviderError({ message: "Pinned image transport is unavailable on mobile" }),
      ),
  }),
);
