import { assert, it } from "@effect/vitest";
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

it("gmail: labels stack, server filters, OAuth", () => {
  assert.deepStrictEqual(providerCapabilities("gmail"), {
    organization: "labels",
    important: true,
    inboxTabs: "categories",
    categories: false,
    copy: false,
    serverLabelStyle: true,
    moveChangesId: false,
    rules: {
      named: false,
      query: true,
      sizeStep: 1,
      excludeChats: true,
      exceptions: false,
      star: true,
      importanceLabel: true,
      labelActions: true,
      serverOnlyActions: false,
      preview: "server",
      recovery: true,
    },
    vacation: { subject: true, openEnded: true, audience: "contacts" },
    optionalServices: true,
    calendar: true,
    sendAs: true,
    signIn: "oauth",
    sharedSession: false,
    webLink: true,
    permanentDeleteScope: true,
    serverForward: false,
  });
});

it("outlook: one folder plus categories, Focused/Other, server rules in 1 KB size steps", () => {
  assert.deepStrictEqual(providerCapabilities("outlook"), {
    organization: "folders",
    important: true,
    inboxTabs: "focused",
    categories: true,
    copy: false,
    serverLabelStyle: false,
    moveChangesId: false,
    rules: {
      named: true,
      query: false,
      sizeStep: 1024,
      excludeChats: false,
      exceptions: true,
      star: false,
      importanceLabel: false,
      labelActions: false,
      serverOnlyActions: true,
      preview: "cache",
      recovery: false,
    },
    vacation: { subject: false, openEnded: false, audience: "internalExternal" },
    optionalServices: true,
    calendar: true,
    sendAs: false,
    signIn: "oauth",
    sharedSession: false,
    webLink: true,
    permanentDeleteScope: false,
    serverForward: true,
  });
});

it("imap: one folder, copy, password sign-in, one shared session, no server rules", () => {
  assert.deepStrictEqual(providerCapabilities("imap"), {
    organization: "folders",
    important: false,
    inboxTabs: null,
    categories: false,
    copy: true,
    serverLabelStyle: false,
    moveChangesId: true,
    rules: null,
    vacation: null,
    optionalServices: false,
    calendar: false,
    sendAs: false,
    signIn: "password",
    sharedSession: true,
    webLink: false,
    permanentDeleteScope: false,
    serverForward: false,
  });
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
