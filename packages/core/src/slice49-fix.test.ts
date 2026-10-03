import { assert, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import type { IncomingMessage } from "./domain.js";
import { ProviderError, SendUncertain } from "./errors.js";
import { MailboxLive } from "./mailbox-live.js";
import { Mailbox } from "./mailbox.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { makeFakeProvider, fakeServer } from "./platform/node/fake-provider.js";
import { Providers, Store, type ProviderAdapter } from "./services.js";
import { StoreLive } from "./store.js";

const message: IncomingMessage = {
  providerId: "old",
  threadId: "old",
  subject: "Old mail",
  from: { name: "Sender", address: "sender@example.com" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "text",
  bodyText: "full body",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [],
  isUnread: true,
  isStarred: false,
};
const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Test",
  text: "Hello",
  attachments: [],
};
const user = { kind: "user", surface: "app" } as const;
function core<A, E>(
  body: Effect.Effect<A, E, Mailbox | Store>,
  overrides: Partial<ProviderAdapter> = {},
) {
  const server = fakeServer("me@gmail.com", [message]);
  const adapter = { ...makeFakeProvider(server), ...overrides };
  const services = Layer.mergeAll(StoreLive, Layer.succeed(Providers, { get: () => adapter })).pipe(
    Layer.provideMerge(MemoryPlatform()),
  );
  return body.pipe(
    Effect.provide(
      MailboxLive({ backgroundFlush: false, imapIdle: false }).pipe(Layer.provideMerge(services)),
    ),
  );
}

it.effect("slice49-fix: label-only history hydrates missing local mail", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      assert.strictEqual((yield* store.getMessage(`${account.id}/old`)).bodyText, "full body");
    }),
    {
      pull: () =>
        Stream.fromIterable([
          { _tag: "MessageLabels", providerId: "old", labels: ["INBOX", "UNREAD"] },
          { _tag: "Cursor", cursor: "2" },
        ]),
    },
  ),
);

it.effect("slice49-fix: uncertain drafts cannot resend until an app user confirms", () => {
  let submissions = 0;
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.saveDraft({ id: "draft:unknown", accountId: account.id, message: outgoing });
      const command = {
        kind: "send",
        accountId: account.id,
        draftId: "draft:unknown",
        message: outgoing,
      } as const;
      assert.strictEqual(
        (yield* mailbox.perform(command, user).pipe(Effect.flip))._tag,
        "SendUncertain",
      );
      const blocked = yield* mailbox.perform(command, user).pipe(Effect.result);
      assert.strictEqual(blocked._tag, "Failure");
      assert.strictEqual(submissions, 1);
      assert.isTrue(yield* store.sendUncertain("draft:unknown"));
      yield* mailbox.perform({ ...command, confirmResend: true }, user);
      assert.strictEqual(submissions, 2);
      assert.isFalse(yield* store.sendUncertain("draft:unknown"));
    }),
    {
      send: () =>
        Effect.suspend(() =>
          ++submissions === 1
            ? Effect.fail(new SendUncertain({ message: "Unknown submission" }))
            : Effect.void,
        ),
    },
  );
});

it.effect("slice63: reconcile remains queued while the provider is unreachable", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* store.enqueueOp(account.id, "missing", { kind: "reconcile" });
      for (let attempt = 0; attempt < 3; attempt++) yield* mailbox.sync();
      assert.strictEqual((yield* store.listPendingOps).length, 1);
      assert.isFalse((yield* mailbox.audit(30)).some((entry) => entry.action === "sync-failed"));
    }),
    { fetchMessage: () => Effect.fail(new ProviderError({ message: "Still offline" })) },
  ),
);

it.effect("slice49-fix: provider pools close on account changes, removal and background", () => {
  const closed: (string | undefined)[] = [];
  return core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      closed.length = 0;
      yield* mailbox.setSyncPaused(true);
      assert.deepStrictEqual(closed, [undefined]);
      yield* mailbox.setSyncPaused(false);
      yield* mailbox.setAccountSettings(account.id, {
        enabled: false,
        description: "Renamed",
        color: null,
      });
      assert.ok(closed.includes(account.id));
      closed.length = 0;
      yield* mailbox.perform({ kind: "removeAccount", accountId: account.id }, user);
      assert.deepStrictEqual(closed, [account.id]);
    }),
    {
      closeSessions: (id) =>
        Effect.sync(() => {
          closed.push(id);
        }),
    },
  );
});

it.effect("slice49-fix: Gmail window resets keep synced drafts outside the window", () =>
  core(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* store.putDraft({ id: "draft:older", accountId: account.id, message: outgoing });
      yield* store.setDraftRemote(
        "draft:older",
        { draftId: "older", messageId: "older-mail" },
        "",
        account.id,
      );
      yield* store.upsertMessage(account.id, {
        ...message,
        providerId: "older-mail",
        labels: ["DRAFT"],
        date: 0,
      });
      yield* mailbox.sync();
      assert.strictEqual((yield* store.getDraft("draft:older"))._tag, "Some");
    }),
    {
      pull: () =>
        Stream.fromIterable([
          { _tag: "Reset", since: 1000, keep: [] },
          { _tag: "Cursor", cursor: "2" },
        ]),
    },
  ),
);
