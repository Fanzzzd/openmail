import { assert, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { Provider } from "../domain/account.js";
import type { MailOp } from "../domain/changes.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { incoming, Store, TestMailbox } from "../platform/node/testing.js";
import {
  labelOpMoves,
  oauthProvider,
  providerCapabilities,
  signsInWithOAuth,
  supportsOp,
} from "./capabilities.js";

const PROVIDERS = ["gmail", "outlook", "imap"] satisfies Provider[];

// One snapshot so a table change shows up in review. The behaviour tests below
// check what core and the guards do with each field.
it("the capability table", () => {
  expect(Object.fromEntries(PROVIDERS.map((p) => [p, providerCapabilities(p)]))).toMatchSnapshot();
});

it("supportsOp maps the gated op kinds to their capability", () => {
  const supported = (provider: Provider) =>
    (["important", "classification", "categories", "copy", "read", "move"] as const).filter(
      (kind) => supportsOp(providerCapabilities(provider), kind),
    );
  assert.deepStrictEqual(supported("gmail"), ["important", "read", "move"]);
  assert.deepStrictEqual(supported("outlook"), [
    "important",
    "classification",
    "categories",
    "read",
    "move",
  ]);
  assert.deepStrictEqual(supported("imap"), ["copy", "read", "move"]);
});

it("a label op moves the message only on folder accounts", () => {
  const add: MailOp = { kind: "label", labelId: "Work", value: true };
  const remove: MailOp = { kind: "label", labelId: "Work", value: false };
  assert.deepStrictEqual(
    PROVIDERS.map((provider) => labelOpMoves(providerCapabilities(provider), add)),
    [false, true, true],
  );
  assert.isFalse(labelOpMoves(providerCapabilities("outlook"), remove));
});

it("the OAuth guards follow signIn", () => {
  assert.deepStrictEqual(PROVIDERS.filter(oauthProvider), ["gmail", "outlook"]);
  assert.deepStrictEqual(
    PROVIDERS.map((provider) => signsInWithOAuth({ provider })),
    [true, true, false],
  );
});

const GATED: MailOp[] = [
  { kind: "classification", value: "other" },
  { kind: "categories", add: ["Blue"], remove: [] },
  { kind: "copy", labelIds: ["Projects"] },
];
const UNAVAILABLE = "This organization action is unavailable for this account.";

// The toolbar, the thread menu and the batch menu show these actions when supportsOp is
// true. Core's batch path must reject exactly the ones they hide.
for (const provider of PROVIDERS)
  for (const op of GATED)
    it.effect(`${provider}: core rejects ${op.kind} exactly when the UI hides it`, () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, "me@example.test");
        const id = provider === "imap" ? "1:1:INBOX" : "one";
        yield* store.upsertMessage(account.id, incoming(id));
        const result = yield* mailbox
          .modifyWithUndo([`${account.id}/${id}`], op)
          .pipe(Effect.result);
        const rejected =
          result._tag === "Failure" &&
          result.failure._tag === "InvalidInput" &&
          result.failure.message === UNAVAILABLE;
        assert.strictEqual(rejected, !supportsOp(providerCapabilities(provider), op.kind));
      }).pipe(Effect.provide(TestMailbox())),
    );

// Core skips an important op the account cannot store, like a move to the current folder.
for (const provider of PROVIDERS)
  it.effect(
    `${provider}: mark important ${supportsOp(providerCapabilities(provider), "important") ? "writes" : "is skipped"}`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, "me@example.test");
        const id = provider === "imap" ? "1:1:INBOX" : "one";
        yield* store.upsertMessage(account.id, incoming(id));
        yield* mailbox.modifyWithUndo([`${account.id}/${id}`], { kind: "important", value: true });
        const message = yield* store.getMessage(`${account.id}/${id}`);
        const writes = supportsOp(providerCapabilities(provider), "important");
        assert.strictEqual(message.labels.includes("IMPORTANT"), writes);
      }).pipe(Effect.provide(TestMailbox())),
  );

// A labelling op on a folder account moves the message out of the inbox.
for (const provider of PROVIDERS)
  it.effect(
    `${provider}: adding a label ${labelOpMoves(providerCapabilities(provider), { kind: "label", labelId: "Work", value: true }) ? "moves" : "keeps"} the message`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, "me@example.test");
        yield* store.replaceLabels(account.id, [{ id: "Work", name: "Work", color: null }]);
        const id = provider === "imap" ? "1:1:INBOX" : "one";
        yield* store.upsertMessage(account.id, incoming(id));
        const op: MailOp = { kind: "label", labelId: "Work", value: true };
        yield* mailbox.modifyWithUndo([`${account.id}/${id}`], op);
        const { labels } = yield* store.getMessage(`${account.id}/${id}`);
        assert.include(labels, "Work");
        assert.strictEqual(
          labels.includes("INBOX"),
          !labelOpMoves(providerCapabilities(provider), op),
        );
      }).pipe(Effect.provide(TestMailbox())),
  );
