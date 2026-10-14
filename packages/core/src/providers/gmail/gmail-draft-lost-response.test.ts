import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type { Account } from "../../domain/account.js";
import type { DraftRemote, OutgoingMessage } from "../../domain/changes.js";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { fakeHttp, type FakeHttpCall } from "../../platform/node/fake-http.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { account as buildAccount } from "../../platform/node/testing.js";
import { DRAFT_WRITE_HEADER } from "../../platform/mail-codec.js";
import type { DraftPush, ProviderAdapter } from "../adapter.js";
import { makeGmail } from "./gmail.js";

const account: Account = buildAccount("gmail");
const platform = MemoryPlatform({
  secrets: { [account.id]: "refresh-token" },
  config: { google: { clientId: "client", clientSecret: "secret" } },
});
const run = <A, E>(
  http: Pick<ReturnType<typeof fakeHttp>, "layer">,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) => makeGmail.pipe(Effect.flatMap(f), Effect.provide(Layer.mergeAll(http.layer, platform)));

const outgoing: OutgoingMessage = {
  to: [{ name: "Ann", address: "ann@x.com" }],
  cc: [],
  bcc: [],
  subject: "Plan",
  text: "first",
  attachments: [],
};

const writeHeader = (call: FakeHttpCall) => {
  const body = call.body as { message: { raw: string } };
  // Gmail returns header values unfolded.
  const mime = Buffer.from(body.message.raw, "base64url")
    .toString("utf8")
    .replace(/\r?\n[ \t]+/g, " ");
  return new RegExp(`^${DRAFT_WRITE_HEADER}: (.+)$`, "im").exec(mime)?.[1]?.trim();
};

/** Gmail draft d1. Every PUT gives it a new message id; `lose` drops the PUT's response. */
const gmailDraft = () => {
  const state = { messageId: "m1", n: 1, nonce: undefined as string | undefined, lose: true };
  const http = fakeHttp({
    "GET /drafts/d1": () => ({ json: { id: "d1", message: { id: state.messageId } } }),
    [`GET /messages/m2`]: () => ({
      json: {
        payload: {
          headers: state.nonce ? [{ name: DRAFT_WRITE_HEADER, value: state.nonce }] : [],
        },
      },
    }),
    "PUT /drafts/d1": (_url, call) => {
      state.messageId = `m${++state.n}`;
      state.nonce = writeHeader(call);
      const reply = { json: { id: "d1", message: { id: state.messageId } } };
      if (!state.lose) return reply;
      state.lose = false;
      return { ...reply, fault: "reset-body" as const };
    },
    "POST /drafts": { json: { id: "d2", message: { id: "dup" } } },
  });
  return { http, state };
};

const push = (
  message: OutgoingMessage,
  remote: DraftRemote,
  writing?: DraftPush["writing"],
): DraftPush => ({
  creation: draftCreation(),
  remote,
  ...(writing ? { writing } : {}),
  message,
  original: Option.none(),
  replaceAttachments: false,
});

it.effect("a lost Gmail draft PUT response does not make the retry a conflict", () =>
  Effect.gen(function* () {
    const { http } = gmailDraft();
    const remote = { draftId: "d1", messageId: "m1" };
    const save = run(http, (a) => a.saveDraft(account, push(outgoing, remote)));
    assert.strictEqual((yield* Effect.result(save))._tag, "Failure");
    const second = yield* save;
    assert.isNotTrue(second.conflict);
    assert.strictEqual(second.draftId, "d1");
    assert.isFalse(
      http.calls.some((c) => c.route === "POST /drafts"),
      "no duplicate draft",
    );
  }),
);

it.effect("after a lost PUT, an edited retry adopts the draft by the persisted write nonce", () =>
  Effect.gen(function* () {
    const { http } = gmailDraft();
    const remote = { draftId: "d1", messageId: "m1" };
    let persisted: string | undefined;
    const writing = (nonce: string) =>
      Effect.sync(() => {
        persisted = nonce;
      });
    const first = run(http, (a) => a.saveDraft(account, push(outgoing, remote, writing)));
    assert.strictEqual((yield* Effect.result(first))._tag, "Failure");
    assert.ok(persisted, "the nonce is persisted before the PUT");
    const edited = { ...outgoing, text: "first, then more" };
    const second = yield* run(http, (a) =>
      a.saveDraft(account, push(edited, { ...remote, writeNonce: persisted! })),
    );
    assert.isNotTrue(second.conflict);
    assert.isFalse(
      http.calls.some((c) => c.route === "POST /drafts"),
      "no duplicate draft",
    );
  }),
);

it.effect("an edit from another Gmail client is still a conflict", () =>
  Effect.gen(function* () {
    const { http, state } = gmailDraft();
    state.messageId = "m2";
    state.nonce = "written-by-another-client";
    const saved = yield* run(http, (a) =>
      a.saveDraft(account, push(outgoing, { draftId: "d1", messageId: "m1" })),
    );
    assert.isTrue(saved.conflict);
    assert.isTrue(http.calls.some((c) => c.route === "POST /drafts"));
  }),
);
