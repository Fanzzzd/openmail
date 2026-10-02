import type { Model } from "./model.js";
import type { Secrets } from "./services.js";
import { Layer } from "effect";

import type { Provider } from "./domain.js";
import { type FakeServer, fakeServer, makeFakeProvider } from "./fake-provider.js";
import { MailboxLive, type MailboxOptions } from "./mailbox-live.js";
import type { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "./platform-memory.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";

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
): Layer.Layer<Mailbox> {
  const adapters = {
    gmail: makeFakeProvider(servers.gmail ?? fakeServer("me@gmail.com"), fakeOptions),
    outlook: makeFakeProvider(servers.outlook ?? fakeServer("me@outlook.com"), fakeOptions),
    imap: makeFakeProvider(servers.imap ?? fakeServer("me@example.com"), fakeOptions),
  };
  const providers = Layer.succeed(Providers, Providers.of({ get: (p) => adapters[p] }));
  return MailboxLive(options).pipe(
    Layer.provide(
      Layer.mergeAll(StoreLive, providers, modelLayer).pipe(Layer.provideMerge(MemoryPlatform())),
    ),
  );
}

export { type FakeServer, fakeServer } from "./fake-provider.js";
