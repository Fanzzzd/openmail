import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError } from "./errors.js";
import { databaseLayer } from "./platform/node/db.js";
import { DEFAULT_PREFS, type OutgoingMessage, type Provider } from "./domain.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";
import { fakeServer, TestMailbox } from "./platform/node/testing.js";

const message: OutgoingMessage = {
  to: [],
  cc: [],
  bcc: [],
  subject: "Draft",
  text: "Body",
  attachments: [],
};
for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: draft labels/star survive provider message replacement and a temporary DB reopen`,
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => mkdtempSync(join(tmpdir(), "openmail-draft-organization-"))),
          (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
        );
        const server = fakeServer("me@example.com");
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
        const accountId = `${provider}:${server.email}`;
        const organization = {
          labels: [provider === "gmail" ? "Label_work" : "Work"],
          starred: true,
        };
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: server.email,
                    password: "fake",
                    imapHost: "imap.example.com",
                    imapPort: 993,
                    smtpHost: "smtp.example.com",
                    smtpPort: 465,
                    smtpSecure: true,
                  },
                }
              : { provider },
          );
          assert.strictEqual((yield* mailbox.prefs).deleteKeyAction, DEFAULT_PREFS.deleteKeyAction);
          yield* mailbox.setPrefs({
            deleteKeyAction: "ask",
            readingPanePosition: "bottom",
            sidebarVisible: false,
          });
          const saved = yield* mailbox.saveDraft({
            id: "draft:organization",
            accountId,
            message: { ...message, draftOrganization: organization },
          });
          assert.strictEqual(saved.synced, true);
          assert.deepStrictEqual(saved.message.draftOrganization, organization);
          assert.deepStrictEqual([...server.messages.values()][0]?.labels, [
            "DRAFT",
            ...(provider === "gmail" ? [] : organization.labels),
          ]);
          assert.strictEqual([...server.messages.values()][0]?.isStarred, provider !== "gmail");
        }).pipe(Effect.provide(layer()));
        yield* Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const opened = yield* mailbox.openDraft("draft:organization");
          assert.deepStrictEqual(opened.message.draftOrganization, organization);
          const prefs = yield* mailbox.prefs;
          assert.strictEqual(prefs.deleteKeyAction, "ask");
          assert.strictEqual(prefs.readingPanePosition, "bottom");
          assert.strictEqual(prefs.sidebarVisible, false);
          yield* mailbox.saveDraft({
            id: opened.id,
            accountId,
            message: { ...opened.message, text: "Edited" },
          });
          assert.strictEqual(server.messages.size, 1);
          assert.deepStrictEqual([...server.messages.values()][0]?.labels, [
            "DRAFT",
            ...(provider === "gmail" ? [] : organization.labels),
          ]);
          assert.strictEqual([...server.messages.values()][0]?.isStarred, provider !== "gmail");
          yield* mailbox.sync();
          const rows = yield* mailbox.threads({ mailbox: "drafts" });
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0]?.isStarred, true);
          yield* mailbox.saveDraft({
            id: opened.id,
            accountId,
            message: { ...opened.message, draftOrganization: { labels: [], starred: false } },
          });
          assert.deepStrictEqual([...server.messages.values()][0]?.labels, ["DRAFT"]);
          assert.strictEqual([...server.messages.values()][0]?.isStarred, false);
        }).pipe(Effect.provide(layer()));
      }).pipe(Effect.scoped),
  );
}

it.effect(
  "draft organization rejects Gmail system labels and unsafe IMAP keywords before saving",
  () =>
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "gmail" });
      const invalid = yield* Effect.flip(
        mailbox.saveDraft({
          id: "draft:invalid",
          accountId: "gmail:me@gmail.com",
          message: { ...message, draftOrganization: { labels: ["TRASH"], starred: false } },
        }),
      );
      assert.strictEqual(invalid._tag, "InvalidInput");
      yield* mailbox.connect({
        provider: "imap",
        input: {
          preset: "custom",
          email: "me@example.com",
          password: "fake",
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpHost: "smtp.example.com",
          smtpPort: 465,
          smtpSecure: true,
        },
      });
      for (const label of ["\\Flagged", "space word", "Work\nInjected"]) {
        const rejected = yield* Effect.flip(
          mailbox.saveDraft({
            id: "draft:invalid-imap",
            accountId: "imap:me@example.com",
            message: { ...message, draftOrganization: { labels: [label], starred: true } },
          }),
        );
        assert.strictEqual(rejected._tag, "InvalidInput");
      }
      assert.deepStrictEqual(yield* mailbox.threads({ mailbox: "drafts" }), []);
    }).pipe(Effect.provide(TestMailbox())),
);

for (const provider of ["outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: offline import leaves organization unknown and later body saves preserve server metadata`,
    () => {
      const server = fakeServer("me@example.com", [
        {
          providerId: "remote",
          threadId: "remote",
          subject: "Remote",
          from: { name: "", address: "me@example.com" },
          to: [],
          cc: [],
          date: 1,
          snippet: "",
          bodyText: "Body",
          bodyHtml: "",
          labels: ["DRAFT", "Work"],
          attachments: [],
          isUnread: false,
          isStarred: true,
        },
      ]);
      const base = makeFakeProvider(server);
      const adapter = {
        ...base,
        getDraftOrganization: () => Effect.fail(new ProviderError({ message: "offline" })),
      };
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* mailbox.connect(
          provider === "imap"
            ? {
                provider,
                input: {
                  preset: "custom",
                  email: server.email,
                  password: "fake",
                  imapHost: "imap.example.com",
                  imapPort: 993,
                  smtpHost: "smtp.example.com",
                  smtpPort: 465,
                  smtpSecure: true,
                },
              }
            : { provider },
        );
        yield* mailbox.sync();
        const opened = yield* mailbox.openDraft(`${provider}:${server.email}/remote`);
        assert.strictEqual(opened.message.draftOrganization, undefined);
        yield* mailbox.saveDraft({
          id: opened.id,
          accountId: opened.accountId,
          message: { ...opened.message, text: "Edited" },
        });
        const last = server.draftLog.at(-1);
        assert.ok(last?.kind === "save");
        assert.strictEqual(last.push.message.draftOrganization, undefined);
        assert.deepStrictEqual([...server.messages.values()][0]?.labels, ["DRAFT", "Work"]);
        assert.strictEqual([...server.messages.values()][0]?.isStarred, true);
      }).pipe(
        Effect.provide(
          MailboxLive({ backgroundFlush: false }).pipe(
            Layer.provide(
              Layer.mergeAll(
                StoreLive,
                Layer.succeed(Providers, Providers.of({ get: () => adapter })),
              ),
            ),
            Layer.provide(MemoryPlatform()),
          ),
        ),
      );
    },
  );
}

it.effect(
  "organization write failure never retries the MIME draft save, while a later label change still pushes",
  () => {
    const server = fakeServer("me@example.com");
    const base = makeFakeProvider(server);
    let decorations = 0;
    const adapter = {
      ...base,
      setDraftOrganization: () => {
        decorations++;
        return Effect.fail(new ProviderError({ message: "label service unavailable" }));
      },
    };
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "outlook" });
      const saved = yield* mailbox.saveDraft({
        id: "draft:decorator",
        accountId: "outlook:me@example.com",
        message: { ...message, draftOrganization: { labels: ["Label_work"], starred: true } },
      });
      assert.strictEqual(saved.synced, true);
      yield* mailbox.sync();
      assert.strictEqual(server.draftLog.length, 1);
      assert.strictEqual(server.drafts.size, 1);
      assert.strictEqual(decorations, 1);
    }).pipe(
      Effect.provide(
        MailboxLive({ backgroundFlush: false }).pipe(
          Layer.provide(
            Layer.mergeAll(
              StoreLive,
              Layer.succeed(Providers, Providers.of({ get: () => adapter })),
            ),
          ),
          Layer.provide(MemoryPlatform()),
        ),
      ),
    );
  },
);

for (const provider of ["outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: unchanged organization is omitted during autosave so remote edits win`,
    () => {
      const server = fakeServer("me@example.com");
      return Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        yield* mailbox.connect(
          provider === "imap"
            ? {
                provider,
                input: {
                  preset: "custom",
                  email: server.email,
                  password: "fake",
                  imapHost: "imap.example.com",
                  imapPort: 993,
                  smtpHost: "smtp.example.com",
                  smtpPort: 465,
                  smtpSecure: true,
                },
              }
            : { provider },
        );
        const accountId = `${provider}:${server.email}`;
        const original = { labels: ["Work"], starred: true };
        // Connect starts a detached pull; finish it before asserting inline draft pushes.
        yield* mailbox.sync(accountId);
        const saved = yield* mailbox.saveDraft({
          id: "draft:remote-edit",
          accountId,
          message: { ...message, draftOrganization: original },
        });
        const remote = [...server.messages.values()][0];
        assert.ok(remote);
        server.messages.set(remote.providerId, {
          ...remote,
          labels: ["DRAFT", "Other"],
          isStarred: false,
        });
        yield* mailbox.saveDraft({
          id: saved.id,
          accountId,
          message: { ...saved.message, text: "New body" },
        });
        const last = server.draftLog.at(-1);
        assert.ok(last?.kind === "save");
        assert.strictEqual(last.push.message.draftOrganization, undefined);
        assert.strictEqual([...server.messages.values()][0]?.isStarred, false);
        assert.deepStrictEqual([...server.messages.values()][0]?.labels, ["DRAFT", "Other"]);
        yield* mailbox.saveDraft({
          id: saved.id,
          accountId,
          message: { ...saved.message, draftOrganization: { labels: [], starred: false } },
        });
        assert.deepStrictEqual([...server.messages.values()][0]?.labels, ["DRAFT"]);
      }).pipe(Effect.provide(TestMailbox({ gmail: server, outlook: server, imap: server })));
    },
  );
}
