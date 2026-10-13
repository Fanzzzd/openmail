import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import { makeOutlookClient } from "./client.js";
import { makeOutlookRead } from "./parse.js";
import { makeOutlookSend } from "./send.js";
import { makeOutlookSync } from "./sync.js";
import type { MailCodec } from "../../platform/mail-codec.js";
import type { AppConfig, OAuth, OAuthIssuers, Secrets } from "../../platform/auth.js";
import type { ProviderAdapter } from "../adapter.js";
export const makeOutlook: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | OAuthIssuers | Secrets | MailCodec
> = Effect.gen(function* () {
  const client = yield* makeOutlookClient;
  const parser = yield* makeOutlookRead(client);
  const send = yield* makeOutlookSend(client);
  const sync = yield* makeOutlookSync(client, parser);
  return {
    ...sync,
    ...send,
    fetchRaw: parser.fetchRaw,
    fetchAttachment: parser.fetchAttachment,
  } satisfies ProviderAdapter;
});
