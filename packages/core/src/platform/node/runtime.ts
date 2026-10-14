import { nodeCacheMaintenance } from "./cache-maintenance.js";
import { CacheStorage, CacheMaintenance } from "../cache-storage.js";
import { nodeCacheStorage } from "./cache-storage.js";
import { UnsubscribeNetwork } from "../../mailbox/unsubscribe.js";
import { postUnsubscribe } from "./unsubscribe.js";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { PlatformCrypto } from "../crypto.js";
import { PlatformHost } from "../host.js";
import { MailCodec } from "../mail-codec.js";
import { AppPaths } from "../paths.js";
import { AppVerifier, AttachmentFiles, ImageNetwork, PdfWorker } from "../runtime.js";
import { nodeMailCodec } from "./mail-codec.js";
import { dataDir } from "./paths.js";
import { PersistentAttachments } from "./persistent-attachments.js";
import { downloadRemoteImage } from "./image-network.js";
import { pdfText } from "./pdf-text.js";
import { isSignedMacApp } from "./app-verifier.js";

export const NodeRuntime = Layer.mergeAll(
  Layer.succeed(CacheStorage, nodeCacheStorage),
  Layer.succeed(CacheMaintenance, nodeCacheMaintenance),
  Layer.succeed(PlatformCrypto, {
    randomUUID,
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
    hmac: (key, value) => createHmac("sha256", key).update(value).digest("hex"),
  }),
  Layer.succeed(MailCodec, nodeMailCodec),
  Layer.succeed(AttachmentFiles, { open: (directory) => new PersistentAttachments(directory) }),
  Layer.succeed(UnsubscribeNetwork, { post: postUnsubscribe }),
  Layer.succeed(ImageNetwork, { download: downloadRemoteImage }),
  Layer.succeed(PdfWorker, { extract: pdfText }),
  Layer.succeed(AppVerifier, { verify: isSignedMacApp }),
);
/** The OS time zone from Intl, read on each call. */
export const NodeHost = Layer.succeed(PlatformHost, {
  timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
});
export const NodePaths = Layer.effect(
  AppPaths,
  Effect.map(dataDir, (directory) => ({ dataDirectory: Effect.succeed(directory) })),
);
