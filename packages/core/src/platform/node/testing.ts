import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCodec } from "../mail-codec.js";
import type { Model } from "../../model.js";
import type { Secrets, Store } from "../../services.js";
import { Effect, Layer } from "effect";

import type { Provider } from "../../domain.js";
import { type FakeServer, fakeServer, makeFakeProvider } from "./fake-provider.js";
import { MailboxLive, type MailboxOptions } from "../../mailbox-live.js";
import type { Mailbox } from "../../mailbox.js";
import { MemoryPlatform, type MemoryPlatformOptions } from "./platform-memory.js";
import { Providers } from "../../services.js";
import { StoreLive } from "../../store.js";

/**
 * A Mailbox over an in-memory database and fake providers: the whole
 * pipeline (policy, local apply, queue, push, pull, audit) with no network
 * or keychain. Servers left out get an empty fake. Queue flushes run inline
 * unless `options` says otherwise, so a test sees a draft's push when the
 * save returns.
 */
export function TestMailbox(
  servers: Partial<Record<Provider, FakeServer>> = {},
  options: MailboxOptions = { backgroundFlush: false },
  fakeOptions: Parameters<typeof makeFakeProvider>[1] = {},
  modelLayer: Layer.Layer<Model, never, Secrets> | Layer.Layer<never> = Layer.empty,
  platformOptions: MemoryPlatformOptions = {},
): Layer.Layer<Mailbox | Store> {
  const providers = Layer.effect(
    Providers,
    Effect.gen(function* () {
      const codec = fakeOptions.codec ?? (yield* MailCodec);
      const adapters = {
        gmail: makeFakeProvider(servers.gmail ?? fakeServer("me@gmail.com"), {
          ...fakeOptions,
          codec,
        }),
        outlook: makeFakeProvider(servers.outlook ?? fakeServer("me@outlook.com"), {
          ...fakeOptions,
          codec,
        }),
        imap: makeFakeProvider(servers.imap ?? fakeServer("me@example.com"), {
          ...fakeOptions,
          codec,
        }),
      };
      return Providers.of({ get: (provider) => adapters[provider] });
    }),
  );
  return MailboxLive(options).pipe(
    Layer.provideMerge(
      Layer.mergeAll(StoreLive, providers, modelLayer).pipe(
        Layer.provideMerge(MemoryPlatform(platformOptions)),
      ),
    ),
  );
}

export { type FakeServer, fakeServer } from "./fake-provider.js";

/** A scoped, temporary node:sqlite database, removed after all services close. */
export function TemporaryTestMailbox(
  servers: Partial<Record<Provider, FakeServer>> = {},
  options: MailboxOptions = { backgroundFlush: false },
) {
  return Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-flow-"))),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    ).pipe(
      Effect.map((directory) =>
        TestMailbox(servers, options, { strictFolders: true }, Layer.empty, {
          database: join(directory, "mail.db"),
        }),
      ),
    ),
  );
}
