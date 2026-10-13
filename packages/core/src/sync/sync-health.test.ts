import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Option } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { StoreLive } from "../store/store.js";
import { MemoryPlatform } from "../platform/node/platform-memory.js";
import { makeFakeProvider } from "../platform/node/fake-provider.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { Providers, Store, type ProviderAdapter } from "../services.js";
import { TestMailbox, fakeServer } from "../platform/node/testing.js";
import { type IncomingMessage, type Provider } from "../domain/domain.js";
import { makeSyncHealth, redactSyncHealth, type HealthVerdict } from "./sync-health.js";
import { sha256Hex } from "../platform/crypto.js";
import { makeGmail } from "../gmail.js";
import { makeResetGuard } from "./sync-reset.js";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ProviderError } from "../domain/errors.js";

const message = (id: string, labels = ["INBOX"], unread = false): IncomingMessage => ({
  providerId: id,
  threadId: "thread",
  subject: "Secret subject",
  from: { name: "Private sender", address: "sender@secret.invalid" },
  to: [],
  cc: [],
  date: 1,
  snippet: "private snippet",
  bodyText: "private message",
  bodyHtml: "",
  labels,
  attachments: [],
  isUnread: unread,
  isStarred: false,
});
for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  for (const verdict of [
    "in sync",
    "local has fewer — window",
    "local has fewer — missing",
    "local has more — stale",
  ] satisfies HealthVerdict[]) {
    // Legacy Outlook cursors do not claim a header window; body windows never excuse header gaps.
    if (provider === "outlook" && verdict === "local has fewer — window") continue;
    it.effect(`${provider} health: ${verdict}, with no writes under OPENMAIL_READ_ONLY=1`, () => {
      const id = provider === "imap" ? "1:1:INBOX" : "one";
      const server = fakeServer("me@example.com", [message(id)]);
      return Effect.gen(function* () {
        const store = yield* Store,
          mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, "me@example.com");
        yield* store.upsertMessage(account.id, message(id));
        yield* store.saveSyncCursor(
          account.id,
          provider === "imap"
            ? JSON.stringify({
                folders: {
                  INBOX: { uidValidity: "1", lastUid: 1, uids: "1", unread: "", starred: "" },
                },
              })
            : "cursor",
        );
        if (verdict === "local has fewer — window" || verdict === "local has fewer — missing") {
          const otherId = provider === "imap" ? "1:2:INBOX" : "two";
          server.messages.set(otherId, message(otherId));
        }
        if (verdict === "local has more — stale") server.messages.clear();
        if (verdict === "local has fewer — missing") {
          yield* store.getBackfillState(account.id);
          const state = Option.getOrThrow(Option.fromUndefinedOr((yield* store.backfillStates)[0]));
          yield* store.saveBackfillState({ ...state, done: true });
        }
        yield* store.enqueueOp(account.id, id, { kind: "star", value: true });
        const before = {
          account: yield* store.getAccount(account.id),
          cursor: yield* store.getSyncCursor(account.id),
          pending: yield* store.listPendingOps,
          backfill: yield* store.backfillStates,
          message: yield* store.getMessage(`${account.id}/${id}`),
        };
        const report = yield* mailbox.syncHealth(account.id);
        assert.deepStrictEqual(
          {
            account: yield* store.getAccount(account.id),
            cursor: yield* store.getSyncCursor(account.id),
            pending: yield* store.listPendingOps,
            backfill: yield* store.backfillStates,
            message: yield* store.getMessage(`${account.id}/${id}`),
          },
          before,
        );
        const folder = report.folders.find((entry) => entry.scope === "INBOX");
        assert.ok(folder);
        assert.strictEqual(folder.verdict, verdict);
        assert.strictEqual(folder.local.total, 1);
        assert.strictEqual(folder.local.threads, 1);
        assert.strictEqual(folder.bodyCacheWindowDays, null);
        assert.strictEqual(folder.pendingOps, 1);
        assert.strictEqual(report.pendingOps, 1);
        assert.strictEqual(report.cursorAgeMs, 0);
        assert.strictEqual(report.accountDomainHash, sha256Hex("example.com"));
        assert.strictEqual(server.pulls.length, 0);
        assert.strictEqual(server.pushed.length, 0);
        assert.strictEqual(server.sent.length, 0);
        assert.strictEqual(server.deleted.length, 0);
        assert.strictEqual(server.draftLog.length, 0);
      }).pipe(
        Effect.provide(
          TestMailbox({ [provider]: server }).pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" })),
            ),
          ),
        ),
      );
    });
  }
}

it.effect(
  "health keeps local scopes and counts offline, redacts arbitrary folder names and errors",
  () => {
    const server = fakeServer("me@example.com");
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox,
        store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const scope = "customer@private.invalid";
      yield* store.replaceLabels(account.id, [{ id: scope, name: "Secret project", color: null }]);
      yield* store.upsertMessage(account.id, message("one", [scope], true));
      yield* store.setCacheWindow({ accountId: account.id, label: scope, days: 30 });
      server.failNext = new ProviderError({
        message: "https://me:password@server.invalid/private",
      });
      const report = yield* mailbox.syncHealth(account.id);
      assert.strictEqual(report.folders[0]?.verdict, "server unavailable");
      const folder = report.folders.find((entry) => entry.scope === scope);
      assert.ok(folder);
      assert.strictEqual(folder.local.unread, 1);
      assert.strictEqual(folder.bodyCacheWindowDays, 30);
      assert.strictEqual(folder.headerWindow, null);
      assert.strictEqual(folder.verdict, "local has more — stale");
      const redacted = JSON.stringify(redactSyncHealth(report));
      for (const secret of [
        "me@example.com",
        "customer@private.invalid",
        "Secret subject",
        "sender@secret.invalid",
        "password",
        "Secret project",
        "private snippet",
        "private message",
      ])
        assert.notInclude(redacted, secret);
      assert.strictEqual(report.cursorAgeMs, null);
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "unread differences are reported even when message totals agree, and account scopes stay isolated",
  () => {
    const server = fakeServer("me@example.com", [message("one", ["INBOX"], true)]);
    return Effect.gen(function* () {
      const mailbox = yield* Mailbox,
        store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const other = yield* store.upsertAccount("gmail", "other@example.com");
      yield* store.upsertMessage(account.id, message("one"));
      yield* store.upsertMessage(other.id, message("two", ["INBOX"], true));
      yield* store.enqueueOp(other.id, "two", { kind: "read", value: false });
      const report = yield* mailbox.syncHealth(account.id);
      assert.strictEqual(report.folders[0]?.verdict, "local has fewer — missing");
      assert.strictEqual(report.folders[0]?.local.total, 1);
      assert.strictEqual(report.pendingOps, 0);
      yield* store.upsertMessage(account.id, message("one", ["INBOX"], true));
      server.messages.set("one", message("one"));
      assert.strictEqual(
        (yield* mailbox.syncHealth(account.id)).folders[0]?.verdict,
        "local has more — stale",
      );
    }).pipe(Effect.provide(TestMailbox({ gmail: server })));
  },
);

it.effect(
  "offline health is bounded per account and performs no SQLite writes across queued scopes",
  () => {
    const server = fakeServer("me@example.com");
    const adapter = { ...makeFakeProvider(server), folderStatus: () => Effect.never };
    const dependencies = Layer.mergeAll(
      StoreLive,
      Layer.succeed(Providers, { get: () => adapter }),
    ).pipe(Layer.provideMerge(MemoryPlatform()));
    return Effect.gen(function* () {
      const store = yield* Store,
        providers = yield* Providers,
        sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.replaceLabels(
        account.id,
        Array.from({ length: 30 }, (_, index) => ({
          id: `Label_${index}`,
          name: `Private ${index}`,
          color: null,
        })),
      );
      yield* store.saveSyncCursor(account.id, "cursor");
      yield* TestClock.adjust("2 seconds");
      const before = yield* sql`SELECT total_changes() AS n`;
      const fiber = yield* makeSyncHealth(store, providers)(account.id).pipe(Effect.forkChild);
      yield* TestClock.adjust("11 seconds");
      const report = yield* Fiber.join(fiber);
      assert.strictEqual(report.cursorAgeMs, 2000);
      assert.strictEqual(report.folders.length, 43);
      assert.isTrue(report.folders.every((folder) => folder.verdict === "server unavailable"));
      assert.deepStrictEqual(yield* sql`SELECT total_changes() AS n`, before);
    }).pipe(Effect.provide(dependencies));
  },
);

it.effect(
  "IMAP health counts exact paths containing colons and reports missing tracked rows despite backfill",
  () => {
    const path = "INBOX:Customers";
    const server = fakeServer("me@example.com", [message(`1:1:${path}`), message(`1:2:${path}`)]);
    return Effect.gen(function* () {
      const store = yield* Store,
        mailbox = yield* Mailbox;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(account.id, message(`1:1:${path}`, [path]));
      yield* store.upsertMessage(account.id, message("1:1:Customers", ["Customers"]));
      yield* store.saveSyncCursor(
        account.id,
        JSON.stringify({
          folders: {
            [path]: { uidValidity: "1", lastUid: 2, uids: "1:2", unread: "", starred: "" },
          },
        }),
      );
      const report = yield* mailbox.syncHealth(account.id);
      assert.strictEqual(report.folders[0]?.local.total, 1);
      assert.strictEqual(report.folders[0]?.verdict, "local has fewer — missing");
      assert.strictEqual(report.folders[0]?.server.kind, "available");
    }).pipe(Effect.provide(TestMailbox({ imap: server })));
  },
);

for (const scope of ["INBOX", "CATEGORY_PERSONAL"]) {
  it.effect(
    `large ${scope} summaries stay available and stale candidates keep being swept despite slow rechecks`,
    () => {
      let listings = 0;
      let verified = 0;
      const client = HttpClient.make((request, url) =>
        Effect.gen(function* () {
          if (url.pathname.endsWith("/messages")) {
            listings++;
            yield* Effect.sleep("2 seconds");
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                messages: Array.from({ length: 500 }, (_, index) => ({
                  id: `id-${listings}-${index}`,
                })),
                nextPageToken: String(listings),
              }),
            );
          }
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              messagesTotal: scope === "CATEGORY_PERSONAL" ? 999 : 29_999,
              messagesUnread: 0,
              threadsTotal: 29_999,
            }),
          );
        }),
      );
      const dependencies = StoreLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            MemoryPlatform({
              secrets: { "gmail:me@example.test": "refresh" },
              config: { google: { clientId: "client", clientSecret: "secret" } },
            }),
            Layer.succeed(HttpClient.HttpClient, client),
          ),
        ),
      );
      return Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.test");
        const gmail = yield* makeGmail;
        yield* store.upsertMessage(account.id, message("cached", [scope]));
        const countedStore: Store["Service"] = {
          ...store,
          syncHealthLocal: (id, label, imap) =>
            label === scope
              ? Effect.succeed({
                  total: 30_000,
                  cachedTotal: 30_000,
                  unmirroredDraftTotal: 0,
                  unread: 0,
                  threads: 30_000,
                  label: scope,
                  pendingOps: 0,
                })
              : store.syncHealthLocal(id, label, imap),
        };
        const adapter = {
          ...makeFakeProvider(fakeServer(account.email)),
          folderStatus: (...args: Parameters<typeof gmail.folderStatus>) =>
            gmail.folderStatus(...args),
          verifyResetCandidates: () =>
            Effect.sync(() => {
              verified++;
              return [];
            }),
        };
        const providers = Providers.of({ get: () => adapter });
        let available = false;
        const sweep = () =>
          makeResetGuard(
            countedStore,
            adapter,
            account,
            { changed: 0, deleted: 0 },
            { remaining: 500 },
          ).sweep(() =>
            makeSyncHealth(
              countedStore,
              providers,
            )(account.id).pipe(
              Effect.orDie,
              Effect.tap((report) =>
                Effect.sync(() => {
                  available =
                    report.folders.find((folder) => folder.scope === scope)?.server.kind ===
                    "available";
                }),
              ),
            ),
          );
        const first = yield* sweep().pipe(Effect.forkChild);
        yield* TestClock.adjust("11 seconds");
        yield* Fiber.join(first);
        assert.isTrue(available);
        assert.strictEqual(verified, 1);
        assert.isAtMost(listings, 2);
        yield* TestClock.adjust("1 hour");
        const second = yield* sweep().pipe(Effect.forkChild);
        yield* TestClock.adjust("11 seconds");
        yield* Fiber.join(second);
        assert.isTrue(available);
        assert.strictEqual(verified, 2);
      }).pipe(Effect.provide(dependencies));
    },
  );
}

for (const [provider, scope, rows, threads] of [
  ["gmail", "CATEGORY_PERSONAL", 22, 21],
  ["outlook", "DRAFT", 40, 37],
] satisfies [Provider, string, number, number][]) {
  it.effect(
    `${provider} health counts ${rows} cached message identities across ${threads} threads with no editable drafts or queued operations`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount(provider, "me@example.test");
        for (let index = 0; index < rows; index++)
          yield* store.upsertMessage(account.id, {
            ...message(`cached-${index}`, [scope]),
            threadId: `thread-${index % threads}`,
            rfcMessageId: `<fixture-${index % threads}@example.test>`,
          });
        const local = yield* store.syncHealthLocal(account.id, scope, false);
        assert.strictEqual(local.total, rows);
        assert.strictEqual(local.threads, threads);
        assert.deepStrictEqual(yield* store.listPendingOps, []);
        assert.strictEqual(
          (yield* store.staleCandidates(account.id, [scope], false, "", 500)).length,
          rows,
        );
      }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
  );
}

it.effect(
  "Outlook Drafts excess reports absent/moved identities without changing cache or drafts",
  () => {
    const remote = fakeServer("me@example.test", [
      message("present", ["DRAFT"]),
      message("moved", ["SENT"]),
    ]);
    const base = makeFakeProvider(remote);
    const adapter: ProviderAdapter = {
      ...base,
      verifyResetCandidates: (_account, candidates) =>
        Effect.sync(() =>
          candidates
            .filter((candidate) => candidate.providerId !== "unavailable")
            .map((candidate) => {
              const message = remote.messages.get(candidate.providerId);
              return message
                ? {
                    kind: "present" as const,
                    id: candidate.providerId,
                    providerId: candidate.providerId,
                    labels: message.labels,
                  }
                : { kind: "gone" as const, id: candidate.providerId };
            }),
        ),
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const account = yield* store.upsertAccount("outlook", remote.email);
      for (const id of ["present", "moved", "gone", "unavailable"])
        yield* store.upsertMessage(account.id, message(id, ["DRAFT"]));
      yield* store.putDraft({
        id: "unmirrored",
        accountId: account.id,
        message: { to: [], cc: [], bcc: [], subject: "draft", text: "keep", attachments: [] },
      });
      yield* store.setDraftRemote(
        "unmirrored",
        { draftId: "absent-draft", messageId: "absent-draft" },
        null,
        account.id,
      );
      const before = yield* store.syncHealthLocal(account.id, "DRAFT", false);
      const report = yield* mailbox.syncHealth(account.id);
      const folder = report.folders.find((entry) => entry.scope === "DRAFT");
      assert.strictEqual(folder?.local.total, 5);
      assert.strictEqual(folder?.server.kind === "available" && folder.server.total, 1);
      assert.deepStrictEqual(folder?.diagnostic, {
        code: "OUTLOOK_DRAFT_COUNT_EXCESS",
        cachedTotal: 4,
        unmirroredDraftTotal: 1,
        sampled: 5,
        gone: 2,
        outsideDrafts: 1,
        presentInDrafts: 1,
        unverified: 1,
      });
      assert.deepStrictEqual(
        redactSyncHealth(report).folders.find((entry) => entry.scope === "DRAFT")?.diagnostic,
        folder?.diagnostic,
      );
      assert.deepStrictEqual(yield* store.syncHealthLocal(account.id, "DRAFT", false), before);
      assert.isTrue(Option.isSome(yield* store.getDraft("unmirrored")));
      assert.deepStrictEqual(yield* store.listPendingOps, []);
      assert.deepStrictEqual(yield* mailbox.listFailedOps, []);
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, { options: { backgroundFlush: false, imapIdle: false } }),
      ),
    );
  },
);

it.effect(
  "Outlook Drafts diagnostic caps its sample and keeps counts available after verification timeout",
  () => {
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.test")),
      verifyResetCandidates: (_account, candidates) => {
        assert.strictEqual(candidates.length, 50);
        return Effect.never;
      },
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const account = yield* store.upsertAccount("outlook", "me@example.test");
      for (let index = 0; index < 51; index++)
        yield* store.upsertMessage(account.id, message(`draft-${index}`, ["DRAFT"]));
      const fiber = yield* mailbox.syncHealth(account.id).pipe(Effect.forkChild);
      yield* TestClock.adjust("11 seconds");
      const report = yield* Fiber.join(fiber);
      const folder = report.folders.find((entry) => entry.scope === "DRAFT");
      assert.strictEqual(folder?.server.kind, "available");
      assert.strictEqual(folder?.local.total, 51);
      assert.deepStrictEqual(folder?.diagnostic, {
        code: "OUTLOOK_DRAFT_COUNT_EXCESS",
        cachedTotal: 51,
        unmirroredDraftTotal: 0,
        sampled: 50,
        gone: 0,
        outsideDrafts: 0,
        presentInDrafts: 0,
        unverified: 50,
      });
      assert.strictEqual((yield* store.syncHealthLocal(account.id, "DRAFT", false)).total, 51);
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(adapter, { options: { backgroundFlush: false, imapIdle: false } }),
      ),
    );
  },
);
