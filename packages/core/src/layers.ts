import type { NodeModelsOptions } from "./embeddings-node.js";
import { makeNodeModels } from "./embeddings-node.js";
import { dataDir } from "./paths.js";
import { Effect, Layer } from "effect";

import { makeGmail } from "./gmail.js";
import { makeImap } from "./imap.js";
import { MailboxLive, type MailboxOptions } from "./mailbox-live.js";
import type { Mailbox } from "./mailbox.js";
import { makeOutlook } from "./outlook.js";
import { NodeSystem, NodePlatform, type NodePlatformOptions } from "./platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const adapters = {
      gmail: yield* makeGmail,
      outlook: yield* makeOutlook,
      imap: yield* makeImap,
    };
    return Providers.of({ get: (provider) => adapters[provider] });
  }),
);

/**
 * `openUrl` or `browser` opens OAuth consent pages (default: the OS opener);
 * `dataDir` defaults to OPENMAIL_HOME or the platform's app data folder.
 */
export interface NodeMailboxOptions extends MailboxOptions, NodePlatformOptions {
  inferenceProcess?: NodeModelsOptions["launch"];
}

/** Mailbox on Node or Electron: node:sqlite, the OS keychain, loopback OAuth, fetch. */
export const NodeMailbox = (options: NodeMailboxOptions = {}): Layer.Layer<Mailbox> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const directory = options.dataDir ?? (yield* dataDir);
      const models =
        options.models ??
        (yield* makeNodeModels(directory, undefined, { launch: options.inferenceProcess }));
      return MailboxLive({
        ...options,
        attachmentCacheDirectory: directory,
        models,
        ...(options.media
          ? {
              media: {
                ...options.media,
                vision: { ...options.media.vision, imageVectors: models.images },
              },
            }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreLive, ProvidersLive).pipe(Layer.provideMerge(NodePlatform(options))),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeSystem));
