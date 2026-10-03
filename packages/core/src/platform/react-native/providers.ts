import { Effect, Layer } from "effect";
import { makeGmail } from "../../gmail.js";
import { makeOutlook } from "../../outlook.js";
import { makeMobileImap } from "./imap.js";
import { Providers } from "../../services.js";

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
