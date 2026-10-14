import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import type { Account } from "../../domain/account.js";
import type { DraftRemote, OutgoingMessage } from "../../domain/changes.js";
import { draftCreation } from "../../platform/node/draft-create-fixture.js";
import { fakeHttp } from "../../platform/node/fake-http.js";
import { MemoryPlatform } from "../../platform/node/platform-memory.js";
import { account as buildAccount } from "../../platform/node/testing.js";
import type { DraftPush, ProviderAdapter } from "../adapter.js";
import { DRAFT_WRITE_PROPERTY } from "./graph-message.js";
import { makeOutlook } from "./outlook.js";

const account: Account = buildAccount("outlook");
const platform = MemoryPlatform({
  secrets: { [account.id]: "refresh-token" },
  config: { microsoft: { clientId: "client" } },
});
const run = <A, E>(
  http: Pick<ReturnType<typeof fakeHttp>, "layer">,
  f: (adapter: ProviderAdapter) => Effect.Effect<A, E>,
) => makeOutlook.pipe(Effect.flatMap(f), Effect.provide(Layer.mergeAll(http.layer, platform)));

const draftMessage: OutgoingMessage = {
  to: [{ name: "Wang", address: "wang@contoso.com" }],
  cc: [],
  bcc: [],
  subject: "Quote",
  text: "draft",
  attachments: [],
};

/** Outlook draft d. Our last known version is changeKey v1, written at 1000. */
const outlookDraft = () => {
  const state = { changeKey: "v1", modified: 1000, nonce: undefined as string | undefined };
  let lose = true;
  const http = fakeHttp({
    "GET /me/messages/d": (url) =>
      url.searchParams.has("$expand")
        ? {
            json: {
              id: "d",
              singleValueExtendedProperties: state.nonce
                ? [{ id: DRAFT_WRITE_PROPERTY, value: state.nonce }]
                : [],
            },
          }
        : {
            json: {
              id: "d",
              changeKey: state.changeKey,
              lastModifiedDateTime: new Date(state.modified).toISOString(),
            },
          },
    // The server applies the PATCH; the first time the connection drops before the reply.
    "PATCH /me/messages/d": (_url, call) => {
      state.changeKey = `v${Number(state.changeKey.slice(1)) + 1}`;
      state.modified += 1000;
      const body = call.body as {
        singleValueExtendedProperties?: readonly { id: string; value: string }[];
      };
      state.nonce = body.singleValueExtendedProperties?.find(
        (p) => p.id === DRAFT_WRITE_PROPERTY,
      )?.value;
      const reply = { json: { id: "d", changeKey: state.changeKey } };
      if (!lose) return reply;
      lose = false;
      return { ...reply, fault: "reset-body" as const };
    },
    "POST /me/messages": { json: { id: "duplicate", changeKey: "c1" } },
  });
  return { http, state };
};

const remote: DraftRemote = { draftId: "d", messageId: "d", changeKey: "v1", lastWrittenAt: 1000 };
const push = (
  message: OutgoingMessage,
  from: DraftRemote,
  writing?: DraftPush["writing"],
): DraftPush => ({
  creation: draftCreation(),
  remote: from,
  ...(writing ? { writing } : {}),
  message,
  original: Option.none(),
  replaceAttachments: false,
});

it.live("a lost Outlook PATCH response does not make the retry a conflict", () =>
  Effect.gen(function* () {
    const { http } = outlookDraft();
    const save = run(http, (a) => a.saveDraft(account, push(draftMessage, remote)));
    assert.strictEqual((yield* Effect.result(save))._tag, "Failure");
    // The queue retries with the same stored remote, since the first save failed.
    const second = yield* save;
    assert.isNotTrue(second.conflict, "our own lost PATCH must not look like another edit");
    assert.strictEqual(second.messageId, "d");
    assert.isFalse(
      http.calls.some((c) => c.route === "POST /me/messages"),
      "no duplicate",
    );
  }),
);

it.live("after a lost PATCH, an edited retry adopts the draft by the persisted write nonce", () =>
  Effect.gen(function* () {
    const { http } = outlookDraft();
    let persisted: string | undefined;
    const writing = (nonce: string) =>
      Effect.sync(() => {
        persisted = nonce;
      });
    const first = run(http, (a) => a.saveDraft(account, push(draftMessage, remote, writing)));
    assert.strictEqual((yield* Effect.result(first))._tag, "Failure");
    assert.ok(persisted, "the nonce is persisted before the PATCH");
    const edited = { ...draftMessage, text: "draft, then more" };
    const second = yield* run(http, (a) =>
      a.saveDraft(account, push(edited, { ...remote, writeNonce: persisted! })),
    );
    assert.isNotTrue(second.conflict);
    assert.isFalse(
      http.calls.some((c) => c.route === "POST /me/messages"),
      "no duplicate",
    );
  }),
);

it.live("an edit from another Outlook client is still a conflict", () =>
  Effect.gen(function* () {
    const { http, state } = outlookDraft();
    state.changeKey = "v2";
    state.modified = 2000;
    state.nonce = "written-by-another-client";
    const saved = yield* run(http, (a) => a.saveDraft(account, push(draftMessage, remote)));
    assert.isTrue(saved.conflict);
    assert.isTrue(http.calls.some((c) => c.route === "POST /me/messages"));
  }),
);
