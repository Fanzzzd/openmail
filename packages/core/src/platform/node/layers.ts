import { ModelAnthropic } from "../../model.js";
import type { NodeModelsOptions } from "./embeddings-node.js";
import { makeNodeModels } from "./embeddings-node.js";
import { dataDir } from "./paths.js";
import { Config, Effect, Layer } from "effect";

import { makeGmail } from "../../gmail.js";
import { makeImap } from "./imap/adapter.js";
import { MailboxLive, type MailboxOptions } from "../../mailbox-live.js";
import type { Mailbox } from "../../mailbox.js";
import { makeOutlook } from "../../outlook.js";
import { NodeSystem, NodePlatform, type NodePlatformOptions } from "./platform-node.js";
import { readOnlyAdapter } from "../../read-only.js";
import { Providers } from "../../services.js";
import { StoreLive } from "../../store.js";
import { OAuthIssuersSql } from "../../store-oauth-issuers.js";

export const ProvidersLive = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const adapters = {
      gmail: yield* makeGmail,
      outlook: yield* makeOutlook,
      imap: yield* makeImap,
    };
    const readOnly =
      (yield* Config.String("OPENMAIL_READ_ONLY").pipe(Config.withDefault("0"), Effect.orDie)) ===
      "1";
    return Providers.of({
      get: (provider) => (readOnly ? readOnlyAdapter(adapters[provider]) : adapters[provider]),
    });
  }),
).pipe(Layer.provideMerge(OAuthIssuersSql));

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
      const media = options.media;
      return MailboxLive({
        ...options,
        attachmentCacheDirectory: directory,
        models,
        ...(media
          ? {
              media: {
                ...media,
                vision: {
                  get available() {
                    return media.vision.available;
                  },
                  get version() {
                    return media.vision.version;
                  },
                  recognize: (data) => media.vision.recognize(data),
                  imageVectors: models.images,
                },
              },
            }
          : {}),
      }).pipe(
        Layer.provide(
          Layer.mergeAll(StoreLive, ProvidersLive, ModelAnthropic).pipe(
            Layer.provideMerge(NodePlatform(options)),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeSystem));
