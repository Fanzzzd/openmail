import { applyNativeMigration } from "./platform/node/migrations.js";
import { assert, it } from "@effect/vitest";
import { TestClock } from "effect/testing";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildMime } from "./platform/node/compose.js";
import { composeSender } from "./compose-sender.js";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import {
  DEFAULT_PREFS,
  type Account,
  type IncomingMessage,
  type OutgoingMessage,
} from "./domain/domain.js";
import { ProviderError } from "./domain/errors.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox/mailbox.js";
import { MailboxLive } from "./mailbox/mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store/store.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";

const original: IncomingMessage = {
  providerId: "sent",
  threadId: "t",
  subject: "Same subject",
  from: { name: "Me", address: "me@example.com" },
  to: [{ name: "Bob", address: "bob@example.com" }],
  cc: [],
  date: 1,
  snippet: "Body",
  bodyText: "Body",
  bodyHtml: "<p>Body</p>",
  labels: ["SENT"],
  attachments: [{ filename: "note.txt", mimeType: "text/plain", size: 2 }],
  isUnread: false,
  isStarred: false,
};
const outgoing: OutgoingMessage = {
  to: original.to,
  cc: [{ name: "Cc", address: "cc@example.com" }],
  bcc: [{ name: "Bcc", address: "private@example.com" }],
  subject: original.subject,
  text: "Body",
  html: "<p>Body</p>",
  attachments: [
    { filename: "note.txt", mimeType: "text/plain", content: "aGk=" },
    { filename: "inline.png", mimeType: "image/png", content: "aGk=", contentId: "image" },
  ],
};

for (const provider of ["gmail", "outlook", "imap"] as const) {
  it.effect(
    `${provider}: Send Again copies MIME addressing, body and attachments into a new persisted draft`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-compose-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com", [original]);
        server.raw.set("sent", yield* buildMime(original.from, outgoing));
        const adapter = makeFakeProvider(server);
        const layer = () =>
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.merge(
                StoreLive.pipe(
                  Layer.provide(
                    databaseLayer(join(directory, "mail.db")).pipe(Layer.provide(NodeSystem)),
                  ),
                ),
                Layer.succeed(Providers, Providers.of({ get: () => adapter })),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          );
        const draft = yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    username: server.email,
                    password: "pw",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const draft = yield* mailbox.sendAgain(`${provider}:me@example.com/sent`);
          assert.notStrictEqual(draft.id, `${provider}:me@example.com/sent`);
          assert.deepStrictEqual(draft.message.to, outgoing.to);
          assert.deepStrictEqual(draft.message.cc, outgoing.cc);
          assert.deepStrictEqual(draft.message.bcc, outgoing.bcc);
          assert.deepStrictEqual(
            draft.message.attachments.toSorted((a, b) => a.filename.localeCompare(b.filename)),
            outgoing.attachments
              .map(({ contentId: _cid, ...file }) => file)
              .toSorted((a, b) => a.filename.localeCompare(b.filename)),
          );
          assert.strictEqual(draft.message.subject, original.subject);
          assert.strictEqual(draft.message.text, "Body");
          assert.include(draft.message.originalHtml ?? "", "<p>Body</p>");
          assert.strictEqual(draft.message.mode, "new");
          assert.strictEqual(draft.message.inReplyTo, undefined);
          assert.strictEqual(server.sent.length, 0);
          assert.ok(server.messages.has("sent"));
          return draft;
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const reopened = yield* mailbox.openDraft(draft.id);
          assert.deepStrictEqual(reopened.message, draft.message);
          yield* mailbox.discardDraft(draft.id);
          assert.ok(server.messages.has("sent"));
        }).pipe(Effect.provide(layer()));
      }),
  );
}

it.effect(
  "Send Again rejects incoming mail and a failed MIME fetch creates no partial draft",
  () => {
    const server = fakeServer("me@example.com", [
      { ...original, labels: ["INBOX"], attachments: [] },
    ]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "gmail" });
      yield* mailbox.sync();
      assert.strictEqual(
        (yield* Effect.flip(mailbox.sendAgain("gmail:me@example.com/sent")))._tag,
        "InvalidInput",
      );
      server.messages.set("sent", original);
      yield* mailbox.sync();
      server.failNext = new ProviderError({ message: "offline" });
      assert.strictEqual(
        (yield* Effect.flip(mailbox.sendAgain("gmail:me@example.com/sent")))._tag,
        "ProviderError",
      );
      assert.deepStrictEqual(yield* mailbox.threads({ mailbox: "drafts" }), []);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect("an existing remote draft is unsynced while its edited save is queued", () => {
  const server = fakeServer("me@example.com");
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const account = yield* mailbox.connect({ provider: "gmail" });
    // Drain connect's detached sync before injecting a failure into the edited save.
    yield* mailbox.sync();
    const draft = yield* mailbox.saveDraft({
      id: "draft:sync",
      accountId: account.id,
      message: outgoing,
    });
    assert.strictEqual(draft.synced, true);
    server.failNext = new ProviderError({ message: "offline" });
    const edited = yield* mailbox.saveDraft({
      id: draft.id,
      accountId: account.id,
      message: { ...outgoing, subject: "Edited" },
    });
    assert.strictEqual(edited.synced, false);
    assert.strictEqual((yield* mailbox.openDraft(draft.id)).synced, false);
    yield* TestClock.adjust("5 seconds");
    yield* mailbox.sync();
    assert.strictEqual((yield* mailbox.openDraft(draft.id)).synced, true);
  }).pipe(Effect.provide(TestMailbox({ gmail: server })));
});

it.effect("core counts sends blocked at the provider and releases the count after failure", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const entered = yield* Deferred.make<void>();
    const server = fakeServer("me@example.com");
    const adapter = makeFakeProvider(server);
    const providers = Layer.succeed(
      Providers,
      Providers.of({
        get: () => ({
          ...adapter,
          send: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(Effect.fail(new ProviderError({ message: "offline" }))),
            ),
        }),
      }),
    );
    yield* Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const account = yield* mailbox.connect({ provider: "gmail" });
      const sending = yield* mailbox
        .perform(
          { kind: "send", accountId: account.id, message: outgoing },
          { kind: "user", surface: "app" },
        )
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered);
      assert.strictEqual(yield* mailbox.pendingSendCount, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(sending);
      assert.strictEqual(yield* mailbox.pendingSendCount, 0);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(Layer.merge(StoreLive, providers)),
          Layer.provide(MemoryPlatform()),
        ),
      ),
    );
  }),
);

it.effect(
  "migration 17 preserves legacy templates and persists Bcc and a fixed From through reopening",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-templates-"))),
        (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
      );
      const file = join(directory, "mail.db");
      yield* Effect.sync(() => {
        const old = new DatabaseSync(file);
        try {
          for (const migration of MIGRATIONS.slice(0, 16)) applyNativeMigration(old, migration);
          old.exec("PRAGMA user_version=16");
          assert.throws(() => old.prepare("SELECT bcc_json FROM templates"), /no such column/);
          old.exec(
            "INSERT INTO templates(id,name,subject,to_json,cc_json,body,updated_at) VALUES('old','Legacy','','[]','[]','Body',1)",
          );
        } finally {
          old.close();
        }
      });
      const layer = () =>
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            StoreLive.pipe(Layer.provide(databaseLayer(file).pipe(Layer.provide(NodeSystem)))),
          ),
          Layer.provide(
            Layer.succeed(
              Providers,
              Providers.of({ get: () => makeFakeProvider(fakeServer("me@example.com")) }),
            ),
          ),
          Layer.provide(MemoryPlatform()),
        );
      const fixed = { accountId: "gmail:me@example.com", address: "alias@example.com" };
      yield* Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        assert.deepStrictEqual((yield* mailbox.templates)[0]?.bcc, []);
        yield* mailbox.setPrefs({ defaultFrom: fixed });
        yield* mailbox.saveTemplate(
          {
            name: "New",
            subject: "Subject",
            to: outgoing.to,
            cc: outgoing.cc,
            bcc: outgoing.bcc,
            body: "Body",
          },
          "old",
        );
      }).pipe(Effect.provide(layer()));
      yield* Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        assert.deepStrictEqual((yield* mailbox.templates)[0]?.bcc, outgoing.bcc);
        assert.deepStrictEqual((yield* mailbox.prefs).defaultFrom, fixed);
        yield* mailbox.setPrefs({ defaultFrom: null });
        assert.strictEqual((yield* mailbox.prefs).defaultFrom, DEFAULT_PREFS.defaultFrom);
      }).pipe(Effect.provide(layer()));
    }),
);

it("fixed From takes precedence; label/account/profile views and removed aliases fall back correctly", () => {
  const first: Account = {
    id: "gmail:first@example.com",
    provider: "gmail",
    email: "first@example.com",
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    profileId: null,
    needsReauth: false,
  };
  const second: Account = { ...first, id: "gmail:second@example.com", email: "second@example.com" };
  const alias = {
    accountId: second.id,
    address: "alias@example.com",
    name: "Alias",
    isDefault: false,
    signature: "",
  };
  const accounts = [first, second];
  assert.strictEqual(
    composeSender(accounts, [], null, { label: { accountId: second.id } }, [first.id])?.accountId,
    second.id,
  );
  assert.strictEqual(
    composeSender(accounts, [], null, { accountId: second.id })?.accountId,
    second.id,
  );
  assert.strictEqual(composeSender(accounts, [], null, {}, [second.id])?.accountId, second.id);
  assert.strictEqual(
    composeSender(
      accounts,
      [],
      { accountId: first.id, address: first.email },
      { accountId: second.id },
    )?.accountId,
    first.id,
  );
  assert.strictEqual(
    composeSender(accounts, [alias], { accountId: second.id, address: "ALIAS@example.com" }, {})
      ?.address,
    alias.address,
  );
  assert.strictEqual(
    composeSender(accounts, [], { accountId: second.id, address: alias.address }, {})?.accountId,
    first.id,
  );
  assert.strictEqual(
    composeSender(accounts, [], { accountId: "removed", address: "gone@example.com" }, {})
      ?.accountId,
    first.id,
  );
  assert.strictEqual(composeSender([], [], null, {}), undefined);
});
