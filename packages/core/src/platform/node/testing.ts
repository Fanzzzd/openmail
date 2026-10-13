import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MailCodec } from "../mail-codec.js";
import type { Model } from "../../ai/model.js";
import type { ProviderAdapter, Secrets, Store } from "../../services.js";
import { Effect, Layer } from "effect";

import type { Account, IncomingMessage, OutgoingMessage, Provider } from "../../domain/domain.js";
import { type FakeServer, fakeServer, makeFakeProvider } from "./fake-provider.js";
import { MailboxLive, type MailboxOptions } from "../../mailbox/mailbox-live.js";
import type { Mailbox } from "../../mailbox/mailbox.js";
import { MemoryPlatform, type MemoryPlatformOptions } from "./platform-memory.js";
import { Providers } from "../../services.js";
import { StoreLive } from "../../store/store.js";

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
  return TestMailbox.withAdapter((base) => base, {
    servers,
    options,
    fakeOptions,
    modelLayer,
    platformOptions,
  });
}

export { Store } from "../../services.js";
export { StoreLive } from "../../store/store.js";

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

/** Override transport behavior while keeping the real mailbox/store pipeline. */
export namespace TestMailbox {
  export function withAdapter(
    adapter: ProviderAdapter | ((base: ProviderAdapter) => ProviderAdapter),
    opts: {
      servers?: Partial<Record<Provider, FakeServer>>;
      options?: MailboxOptions;
      fakeOptions?: Parameters<typeof makeFakeProvider>[1];
      modelLayer?: Layer.Layer<Model, never, Secrets> | Layer.Layer<never>;
      platformOptions?: MemoryPlatformOptions;
    } = {},
  ) {
    const providers = Layer.effect(
      Providers,
      Effect.gen(function* () {
        const codec = opts.fakeOptions?.codec ?? (yield* MailCodec);
        const adapt = (provider: Provider) =>
          typeof adapter === "function"
            ? adapter(
                makeFakeProvider(
                  opts.servers?.[provider] ??
                    fakeServer(`me@${provider === "imap" ? "example" : provider}.com`),
                  { ...opts.fakeOptions, codec },
                ),
              )
            : adapter;
        const adapters = { gmail: adapt("gmail"), outlook: adapt("outlook"), imap: adapt("imap") };
        return Providers.of({ get: (provider) => adapters[provider] });
      }),
    );
    return MailboxLive(opts.options ?? { backgroundFlush: false }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(StoreLive, providers, opts.modelLayer ?? Layer.empty).pipe(
          Layer.provideMerge(MemoryPlatform(opts.platformOptions)),
        ),
      ),
    );
  }
}

export function incoming(
  providerId = "one",
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    providerId,
    threadId: `t-${providerId}`,
    subject: `主题 ${providerId}`,
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "", address: "me@gmail.com" }],
    cc: [],
    date: 1000,
    snippet: "",
    bodyText: "你好",
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: true,
    isStarred: false,
    ...overrides,
  };
}

export function outgoing(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    subject: "计划",
    text: "v1",
    attachments: [],
    ...overrides,
  };
}

export function account(provider: Provider, overrides: Partial<Account> = {}): Account {
  const email = `me@${provider === "imap" ? "example" : provider}.com`;
  return {
    id: `${provider}:${email}`,
    provider,
    email,
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
    needsReauth: false,
    ...overrides,
  };
}
