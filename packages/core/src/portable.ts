import { Effect, Layer } from "effect";
import { makeGmail } from "./gmail.js";
import { makeOutlook } from "./outlook.js";
import { makeMobileImap } from "./platform/react-native/imap.js";
import { Providers } from "./services.js";

// Mobile entry: shared core plus mobile adapters and workflows.
export * from "./common.js";
export * from "./mobile-outbox.js";
export * from "./mobile-background.js";
export * from "./mobile-compose.js";
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
);
