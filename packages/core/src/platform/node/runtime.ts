import { createHash, createHmac, randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";
import { PlatformCrypto } from "../crypto.js";
import { MailCodec } from "../mail-codec.js";
import { AppPaths } from "../paths.js";
import {
  AppVerifier,
  AttachmentFiles,
  DatabaseFiles,
  ImageNetwork,
  InferenceWorker,
  PdfWorker,
} from "../runtime.js";
import { nodeMailCodec } from "./mail-codec.js";
import { dataDir } from "./paths.js";
import { PersistentAttachments } from "./persistent-attachments.js";
import { downloadRemoteImage } from "./image-network.js";
import { pdfText } from "./pdf-text.js";
import { isSignedMacApp } from "./app-verifier.js";
import { nodeInferenceProcess } from "./inference-process.js";
import { databaseQuickCheck, rebuildCorruptDatabase } from "./database-recovery.js";
import { prepareDatabaseStartup } from "./recovery-files.js";

export const NodeRuntime = Layer.mergeAll(
  Layer.succeed(PlatformCrypto, {
    randomUUID,
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
    hmac: (key, value) => createHmac("sha256", key).update(value).digest("hex"),
  }),
  Layer.succeed(MailCodec, nodeMailCodec),
  Layer.succeed(AttachmentFiles, { open: (directory) => new PersistentAttachments(directory) }),
  Layer.succeed(ImageNetwork, { download: downloadRemoteImage }),
  Layer.succeed(PdfWorker, { extract: pdfText }),
  Layer.succeed(AppVerifier, { verify: isSignedMacApp }),
  Layer.succeed(InferenceWorker, { launch: nodeInferenceProcess }),
  Layer.succeed(DatabaseFiles, {
    prepareStartup: prepareDatabaseStartup,
    quickCheck: databaseQuickCheck,
    rebuild: rebuildCorruptDatabase,
  }),
);
export const NodePaths = Layer.effect(
  AppPaths,
  Effect.map(dataDir, (directory) => ({ dataDirectory: Effect.succeed(directory) })),
);
