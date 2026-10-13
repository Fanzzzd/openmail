import { Effect, Layer } from "effect";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import type { Mailbox } from "./mailbox/mailbox.js";
import type { MailCodec } from "./platform/mail-codec.js";
import type { MailTransport } from "./platform/mail-socket.js";
import type { AttachmentFiles, ImageNetwork, PdfWorker } from "./platform/runtime.js";
import { MailboxLive, type MailboxOptions } from "./mailbox/mailbox-live.js";
import { ModelAnthropic } from "./model.js";
import { StoreLive } from "./store/store.js";
import { OAuthIssuersSql } from "./store/store-oauth-issuers.js";
import { makeGmail } from "./providers/gmail/gmail.js";
import { makeOutlook } from "./providers/outlook/outlook.js";
import { makeMobileImap } from "./platform/react-native/imap.js";
import { Providers, type AppConfig, type OAuth, type Secrets } from "./services.js";

// Mobile entry: shared core plus mobile adapters and workflows.
export * from "./common.js";
export * from "./mailbox/mobile-outbox.js";
export * from "./mailbox/mobile-background.js";
export * from "./compose/mobile-compose.js";
export { opSqliteLayer } from "./platform/react-native/sqlite.js";
export * from "./platform/react-native/database-recovery.js";
export { mobileMediaLayer } from "./platform/react-native/media.js";
export { mobileOAuthLayer, type MobileAuthSession } from "./platform/react-native/oauth.js";
export { mobileMailCodecLayer } from "./platform/react-native/mail-codec.js";
export { stripMobileForms } from "./platform/react-native/reader-html.js";
export * from "./platform/mail-socket.js";

export const mobileProvidersLayer = Layer.effect(
  Providers,
  Effect.gen(function* () {
    const gmail = yield* makeGmail;
    const outlook = yield* makeOutlook;
    const imap = yield* makeMobileImap;
    const adapters = { gmail, outlook, imap };
    return Providers.of({ get: (provider) => adapters[provider] });
  }),
).pipe(Layer.provideMerge(OAuthIssuersSql));

/** Mailbox with portable persistence, providers and model; the caller supplies platform services. */
export const PortableMailbox = (
  options: MailboxOptions = {},
): Layer.Layer<
  Mailbox,
  never,
  | SqlClient.SqlClient
  | Secrets
  | AppConfig
  | OAuth
  | MailCodec
  | PdfWorker
  | AttachmentFiles
  | ImageNetwork
  | HttpClient.HttpClient
  | MailTransport
> =>
  MailboxLive(options).pipe(
    Layer.provide(Layer.mergeAll(StoreLive, mobileProvidersLayer, ModelAnthropic)),
  );
