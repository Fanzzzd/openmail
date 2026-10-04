import type { HttpClient } from "effect/http";
import type { MailCodec } from "./platform/mail-codec.js";
import { Effect } from "effect";
import type { AppConfig, OAuth, Secrets, ProviderAdapter } from "./services.js";
import { makeGraphClient } from "./outlook/client.js";
import { makeOutlookParse } from "./outlook/parse.js";
import { makeOutlookSend } from "./outlook/send.js";
import { makeOutlookSync } from "./outlook/sync.js";
export { destination, type GraphMessage } from "./outlook/graph.js";
export { parseGraphMessage } from "./outlook/parse.js";
export { MARKDOWN_DRAFT_PROPERTY } from "./outlook/send.js";
export const makeOutlook: Effect.Effect<
  ProviderAdapter,
  never,
  HttpClient.HttpClient | OAuth | AppConfig | Secrets | MailCodec
> = Effect.gen(function* () {
  const client = yield* makeGraphClient;
  const parser = yield* makeOutlookParse(client);
  const send = yield* makeOutlookSend(client);
  const sync = yield* makeOutlookSync(client, parser);
  return {
    ...sync,
    ...send,
    fetchRaw: parser.fetchRaw,
    fetchAttachment: parser.fetchAttachment,
  } satisfies ProviderAdapter;
});
