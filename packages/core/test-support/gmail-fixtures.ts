/** Shared fixtures for the Gmail adapter tests in src/providers/gmail/gmail-*.test.ts. */
import { account as buildAccount } from "../src/platform/node/testing.js";
import { fakeHttp } from "../src/platform/node/fake-http.js";
import { Effect, Layer, Schema } from "effect";
import type { Account } from "../src/domain/account.js";
import type { OutgoingMessage } from "../src/domain/changes.js";
import { makeGmail } from "../src/providers/gmail/gmail.js";
import { MemoryPlatform } from "../src/platform/node/platform-memory.js";
import type { Change, ProviderAdapter } from "../src/providers/adapter.js";

/**
 * An HttpClient that answers from `routes`, keyed by "METHOD /path" under the
 * Gmail API base. Unknown routes answer 404, like a missing resource.
 */

export const account: Account = buildAccount("gmail");

export const platform = MemoryPlatform({
  secrets: { [account.id]: "refresh-token" },
  config: { google: { clientId: "client", clientSecret: "secret" } },
});

export function run<A, E>(
  http: Pick<ReturnType<typeof fakeHttp>, "layer" | "calls">,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) {
  return makeGmail.pipe(Effect.flatMap(f), Effect.provide(Layer.mergeAll(http.layer, platform)));
}

export const b64 = (s: string) => Buffer.from(s).toString("base64url");

export const message = (id: string, labelIds: string[]) => ({
  id,
  threadId: `t-${id}`,
  labelIds,
  snippet: "Tom &amp; Jerry",
  internalDate: "1700000000000",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "Subject", value: `Subject ${id}` },
      { name: "From", value: "Ann <ann@x.com>" },
    ],
    body: { size: 5, data: b64("hello") },
  },
});

export const labels = {
  labels: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "Label_1", name: "Clients", type: "user", color: { backgroundColor: "#fb4c2f" } },
    { id: "Label_2", name: "Clients/Acme", type: "user" },
  ],
};

export const tags = (changes: readonly Change[]) => changes.map((c) => c._tag);

export const outgoing: OutgoingMessage = {
  to: [{ name: "Ann", address: "ann@x.com" }],
  cc: [],
  bcc: [{ name: "", address: "hidden@x.com" }],
  subject: "Re: plan",
  text: "sounds good",
  attachments: [],
};

export const DraftBody = Schema.Struct({
  message: Schema.Struct({ raw: Schema.String, threadId: Schema.optionalKey(Schema.String) }),
});

export const revoke = (adapter: ProviderAdapter) =>
  adapter.revokeGrant?.(account.id) ?? Effect.die("Gmail has no revokeGrant");
