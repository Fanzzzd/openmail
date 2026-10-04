import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import { makeOutlookClient } from "./outlook/client.js";
import { makeOutlookRead } from "./outlook/parse.js";
import { makeOutlookSend } from "./outlook/send.js";
import { makeOutlookSync } from "./outlook/sync.js";
import type { MailCodec } from "./platform/mail-codec.js";
import type { AppConfig, OAuth, ProviderAdapter, Secrets } from "./services.js";
export const makeOutlook: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | Secrets | MailCodec
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
