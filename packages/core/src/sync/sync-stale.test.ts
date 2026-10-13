import { assert, it } from "@effect/vitest";
import { Clock, Effect, Fiber, Logger, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type IncomingMessage, type OutgoingMessage, type Provider } from "../domain/domain.js";
import { Mailbox } from "../mailbox/mailbox.js";
import { fakeServer, makeFakeProvider } from "../platform/node/fake-provider.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Store } from "../store/service.js";
import type { Change, ProviderAdapter } from "../providers/adapter.js";
import { type SyncHealth } from "./sync-health.js";
import { makeResetGuard } from "./sync-reset.js";
const message = (providerId: string, labels: string[]): IncomingMessage => ({
  providerId,
  threadId: providerId,
  subject: "Stale",
  from: { name: "", address: "a@example.test" },
  to: [],
  cc: [],
  date: 1,
  snippet: "",
  bodyText: "",
  bodyHtml: "",
  attachments: [],
  labels,
  isUnread: false,
  isStarred: false,
});
const draft: OutgoingMessage = {
  to: [],
  cc: [],
  bcc: [],
  subject: "Draft",
  text: "Text",
  attachments: [],
};
function runtime(adapter: ProviderAdapter) {
  return TestMailbox.withAdapter(adapter, {
    options: { backgroundFlush: false, imapIdle: false },
    platformOptions: {},
  });
}

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(
    `${provider}: stale health verifies absence and moves, then converges without touching local drafts`,
    () => {
      const scope =
        provider === "gmail" ? "CATEGORY_PERSONAL" : provider === "outlook" ? "DRAFT" : "INBOX";
      const id = (n: number) => (provider === "imap" ? `1:${n}:INBOX` : `m${n}`);
      const server = fakeServer("me@example.test", [
        message(id(1), [scope]),
        message(id(3), ["SENT"]),
      ]);
      const checked: string[] = [];
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(server),
        pull: () =>
          Stream.succeed({
            _tag: "Cursor",
            cursor:
              provider === "imap"
                ? JSON.stringify({
                    folders: {
                      INBOX: { uidValidity: "1", lastUid: 3, uids: "1:3", unread: "", starred: "" },
                    },
                  })
                : "1",
          }),
        verifyResetCandidates: (_account, candidates) =>
          Effect.sync(() =>
            candidates.map((candidate) => {
              checked.push(candidate.providerId);
              const remote = server.messages.get(candidate.providerId);
              return remote
                ? {
                    kind: "present" as const,
                    id: candidate.providerId,
                    providerId: candidate.providerId,
                    labels: remote.labels,
                  }
                : { kind: "gone" as const, id: candidate.providerId };
            }),
          ),
      };
      return Effect.gen(function* () {
        const store = yield* Store,
          mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, server.email);
        for (let n = 1; n <= 3; n++)
          yield* store.upsertMessage(account.id, message(id(n), [scope]));
        yield* store.putDraft({ id: "local", accountId: account.id, message: draft });
        if (provider === "outlook") {
          yield* store.putDraft({ id: "remote", accountId: account.id, message: draft });
          yield* store.setDraftRemote("remote", { draftId: id(3), messageId: id(3) }, null);
        }
        yield* mailbox.sync(account.id);
        assert.strictEqual(
          (yield* mailbox.syncHealth(account.id)).folders.find((f) => f.scope === scope)?.verdict,
          "in sync",
        );
        assert.strictEqual(yield* store.messageIdForProvider(account.id, id(2)), null);
        assert.deepStrictEqual((yield* store.getMessage(`${account.id}/${id(3)}`)).labels, [
          "SENT",
        ]);
        assert.isTrue(Option.isSome(yield* store.getDraft("local")));
        if (provider === "outlook") assert.isTrue(Option.isNone(yield* store.getDraft("remote")));
        assert.strictEqual(checked.length, 3);
      }).pipe(Effect.provide(runtime(adapter)));
    },
  );
}

it.effect("Gmail label-only history removes remote drafts and keeps system category labels", () => {
  const server = fakeServer("me@example.test");
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    pull: () =>
      Stream.fromIterable<Change>([
        { _tag: "Labels", labels: [] },
        { _tag: "MessageLabels", providerId: "m1", labels: ["SENT", "CATEGORY_PERSONAL"] },
        { _tag: "Cursor", cursor: "2" },
      ]),
  };
  return Effect.gen(function* () {
    const store = yield* Store,
      mailbox = yield* Mailbox;
    const account = yield* store.upsertAccount("gmail", server.email);
    yield* store.upsertMessage(account.id, message("m1", ["DRAFT", "CATEGORY_SOCIAL"]));
    yield* store.putDraft({ id: "remote", accountId: account.id, message: draft });
    yield* store.setDraftRemote("remote", { draftId: "d1", messageId: "m1" }, null);
    yield* mailbox.sync(account.id);
    assert.isTrue(Option.isNone(yield* store.getDraft("remote")));
    assert.deepStrictEqual((yield* store.getMessage(`${account.id}/m1`)).labels, [
      "SENT",
      "CATEGORY_PERSONAL",
    ]);
  }).pipe(Effect.provide(runtime(adapter)));
});

it.effect(
  "stale sweeps have independent account caps, rotate failures hourly and persist cooldowns",
  () => {
    const server = fakeServer("me@example.test");
    const calls: { account: string; ids: string[] }[] = [];
    let fail = true;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(server),
      pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
      verifyResetCandidates: (account, candidates) =>
        Effect.sync(() => {
          calls.push({ account: account.id, ids: candidates.map((c) => c.providerId) });
          return fail ? [] : candidates.map((c) => ({ kind: "gone" as const, id: c.providerId }));
        }),
    };
    return Effect.gen(function* () {
      const store = yield* Store,
        mailbox = yield* Mailbox;
      const first = yield* store.upsertAccount("gmail", server.email);
      const second = yield* store.upsertAccount("gmail", "other@example.test");
      for (let n = 0; n < 503; n++)
        yield* store.upsertMessage(
          first.id,
          message(`m${String(n).padStart(3, "0")}`, ["INBOX", "CATEGORY_PERSONAL"]),
        );
      yield* store.upsertMessage(second.id, message("second", ["INBOX"]));
      // Accounts sync concurrently, so calls are compared per account.
      const of = (id: string) => calls.filter((call) => call.account === id).map((c) => c.ids);
      yield* mailbox.sync();
      assert.strictEqual(calls.length, 2);
      assert.strictEqual(of(first.id)[0]?.length, 500);
      assert.deepStrictEqual(of(second.id), [["second"]]);
      assert.strictEqual((yield* store.syncHealthLocal(first.id, "INBOX", false)).total, 503);
      yield* mailbox.sync();
      assert.strictEqual(calls.length, 2);
      yield* TestClock.adjust("59 minutes");
      yield* mailbox.sync();
      assert.strictEqual(calls.length, 2);
      fail = false;
      yield* TestClock.adjust("1 minute");
      yield* mailbox.sync();
      const rotated = of(first.id)[1];
      assert.strictEqual(rotated?.length, 500);
      assert.deepStrictEqual(rotated?.slice(0, 3), ["m500", "m501", "m502"]);
      assert.strictEqual(new Set(rotated).size, 500);
      assert.strictEqual((yield* store.syncHealthLocal(first.id, "INBOX", false)).total, 3);
      yield* TestClock.adjust("1 hour");
      yield* mailbox.sync();
      assert.strictEqual((yield* mailbox.syncHealth(first.id)).folders[0]?.verdict, "in sync");
      // A fresh guard would still see the SQLite cooldown. It is not process-local.
      assert.isTrue(Option.isNone(yield* store.claimStaleSweep(first.id, 7_200_000)));
      assert.deepStrictEqual(server.pushed, []);
      assert.deepStrictEqual(server.sent, []);
    }).pipe(Effect.provide(runtime(adapter)));
  },
);

it.effect(
  "remote draft orphans are counted once and individually verified; unuploaded and local-only drafts survive",
  () => {
    const server = fakeServer("me@example.test", [message("present", ["DRAFT"])]);
    const ids: string[] = [];
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(server),
      pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
      draftMessageIds: () => Effect.succeed(["present"]),
      verifyResetCandidates: (_account, candidates) =>
        Effect.sync(() =>
          candidates.map((c) => {
            ids.push(c.providerId);
            return { kind: "gone" as const, id: c.providerId };
          }),
        ),
    };
    return Effect.gen(function* () {
      const store = yield* Store,
        mailbox = yield* Mailbox;
      const account = yield* store.upsertAccount("gmail", server.email);
      for (const [id, remote] of [
        ["present", "present"],
        ["gone1", "gone"],
        ["gone2", "gone"],
        ["unuploaded", null],
        ["protected", "protected"],
        ["failed", "failed"],
      ] satisfies [string, string | null][]) {
        yield* store.putDraft({ id, accountId: account.id, message: draft });
        if (remote) yield* store.setDraftRemote(id, { draftId: id, messageId: remote }, null);
      }
      yield* store.setDraftLocalOnly("protected", true);
      yield* store.setDraftSyncError("failed", "Unsaved edit");
      assert.strictEqual((yield* store.syncHealthLocal(account.id, "DRAFT", false)).total, 2);
      yield* mailbox.sync(account.id);
      assert.deepStrictEqual(ids, ["gone"]);
      assert.isTrue(Option.isNone(yield* store.getDraft("gone1")));
      assert.isTrue(Option.isNone(yield* store.getDraft("gone2")));
      for (const id of ["present", "unuploaded", "protected", "failed"])
        assert.isTrue(Option.isSome(yield* store.getDraft(id)));
      assert.strictEqual(
        (yield* mailbox.syncHealth(account.id)).folders.find((f) => f.scope === "DRAFT")?.verdict,
        "in sync",
      );
      yield* store.upsertMessage(account.id, message("present", ["DRAFT"]));
      assert.strictEqual((yield* store.syncHealthLocal(account.id, "DRAFT", false)).total, 1);
    }).pipe(Effect.provide(runtime(adapter)));
  },
);

it.effect("unavailable server counts never trigger a stale sweep", () => {
  const server = fakeServer("me@example.test");
  let verifications = 0;
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
    folderStatus: () => Effect.never,
    verifyResetCandidates: () =>
      Effect.sync(() => {
        verifications++;
        return [];
      }),
  };
  return Effect.gen(function* () {
    const store = yield* Store,
      mailbox = yield* Mailbox;
    const account = yield* store.upsertAccount("gmail", server.email);
    yield* store.upsertMessage(account.id, message("one", ["CATEGORY_PERSONAL"]));
    const fiber = yield* mailbox.sync(account.id).pipe(Effect.forkChild);
    yield* TestClock.adjust("11 seconds");
    yield* Fiber.join(fiber);
    assert.strictEqual(verifications, 0);
    assert.strictEqual(yield* store.messageIdForProvider(account.id, "one"), `${account.id}/one`);
  }).pipe(Effect.provide(runtime(adapter)));
});

for (const [provider, scope, local, remote] of [
  ["gmail", "CATEGORY_PERSONAL", 22, 21],
  ["outlook", "DRAFT", 40, 37],
] satisfies [Provider, string, number, number][]) {
  it.effect(
    `${provider}: real-data count pattern ${local}/${remote} converges after verified cleanup`,
    () => {
      const server = fakeServer(
        "me@example.test",
        Array.from({ length: remote }, (_, n) => message(`m${n}`, [scope])),
      );
      if (provider === "gmail") server.messages.set(`m${remote}`, message(`m${remote}`, ["INBOX"]));
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(server),
        pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
        verifyResetCandidates: (_account, candidates) =>
          Effect.succeed(
            candidates.map((c) => {
              const present = server.messages.get(c.providerId);
              return present
                ? {
                    kind: "present" as const,
                    id: c.providerId,
                    providerId: c.providerId,
                    labels: present.labels,
                  }
                : { kind: "gone" as const, id: c.providerId };
            }),
          ),
      };
      return Effect.gen(function* () {
        const store = yield* Store,
          mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, server.email);
        for (let n = 0; n < local; n++) {
          yield* store.upsertMessage(account.id, message(`m${n}`, [scope]));
          if (provider === "outlook") {
            yield* store.putDraft({ id: `draft${n}`, accountId: account.id, message: draft });
            yield* store.setDraftRemote(
              `draft${n}`,
              { draftId: `m${n}`, messageId: `m${n}` },
              null,
            );
          }
        }
        assert.strictEqual(
          (yield* mailbox.syncHealth(account.id)).folders.find((f) => f.scope === scope)?.verdict,
          "local has more — stale",
        );
        yield* mailbox.sync(account.id);
        const folder = (yield* mailbox.syncHealth(account.id)).folders.find(
          (f) => f.scope === scope,
        );
        assert.strictEqual(folder?.verdict, "in sync");
        assert.strictEqual(folder?.local.total, remote);
        if (provider === "gmail") {
          const retained = yield* store.getMessage(`${account.id}/m${remote}`);
          assert.deepStrictEqual(retained.labels, ["INBOX"]);
          assert.strictEqual(retained.subject, "Stale");
        } else
          for (let n = remote; n < local; n++)
            assert.isTrue(Option.isNone(yield* store.getDraft(`draft${n}`)));
      }).pipe(Effect.provide(runtime(adapter)));
    },
  );
}

for (const provider of ["gmail", "outlook", "imap"] satisfies Provider[]) {
  it.effect(`${provider}: unread-only staleness does not spend either verification budget`, () => {
    const id = provider === "imap" ? "1:1:INBOX" : "one";
    const server = fakeServer("me@example.test", [message(id, ["INBOX"])]);
    let checked = 0;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(server),
      verifyResetCandidates: () =>
        Effect.sync(() => {
          checked++;
          return [];
        }),
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount(provider, server.email);
      yield* store.upsertMessage(account.id, {
        ...message(id, ["INBOX", "UNREAD"]),
        isUnread: true,
      });
      const budget = { remaining: 500 };
      const guard = makeResetGuard(store, adapter, account, { changed: 0, deleted: 0 }, budget);
      yield* guard.sweep(() =>
        Effect.succeed({
          provider,
          accountDomainHash: "hash",
          checkedAt: 0,
          cursorAgeMs: null,
          pendingOps: 0,
          folders: [
            {
              scope: "INBOX",
              local: { total: 1, unread: 1, threads: 1 },
              server: {
                kind: "available",
                total: 1,
                unread: 0,
                threads: null,
                uidNext: null,
                uidValidity: null,
              },
              bodyCacheWindowDays: null,
              headerWindow: null,
              cursorAgeMs: null,
              pendingOps: 0,
              verdict: "local has more — stale",
            },
          ],
        } satisfies SyncHealth),
      );
      assert.strictEqual(checked, 0);
      assert.strictEqual(budget.remaining, 500);
    }).pipe(Effect.provide(runtime(adapter)));
  });
}

const staleHealth = (provider: Provider, scope: string, total: number): Effect.Effect<SyncHealth> =>
  Effect.succeed({
    provider,
    accountDomainHash: "hash",
    checkedAt: 0,
    cursorAgeMs: null,
    pendingOps: 0,
    folders: [
      {
        scope,
        local: { total, unread: 0, threads: total },
        server: {
          kind: "available",
          total: 0,
          unread: 0,
          threads: null,
          uidNext: null,
          uidValidity: null,
        },
        bodyCacheWindowDays: null,
        headerWindow: null,
        cursorAgeMs: null,
        pendingOps: 0,
        verdict: "local has more — stale",
      },
    ],
  });

it.effect("a sweep of present mail reapplies pending ops and preserves their queue", () => {
  const server = fakeServer("me@example.test");
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    verifyResetCandidates: (_account, candidates) =>
      Effect.succeed(
        candidates.map((c) => ({
          kind: "present" as const,
          id: c.providerId,
          providerId: c.providerId,
          labels: ["INBOX"],
        })),
      ),
  };
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", server.email);
    yield* store.upsertMessage(account.id, message("one", ["INBOX", "CATEGORY_PERSONAL"]));
    yield* store.enqueueOp(account.id, "one", { kind: "star", value: true });
    yield* store.enqueueOp(account.id, "one", { kind: "read", value: false });
    const pending = yield* store.listPendingOps;
    const budget = { remaining: 500 };
    const guard = makeResetGuard(store, adapter, account, { changed: 0, deleted: 0 }, budget);
    yield* guard.sweep(() => staleHealth("gmail", "CATEGORY_PERSONAL", 1));
    const current = yield* store.getMessage(`${account.id}/one`);
    assert.deepStrictEqual(current.labels, ["INBOX", "STARRED", "UNREAD"]);
    assert.isTrue(current.isUnread);
    assert.isTrue(current.isStarred);
    assert.deepStrictEqual(yield* store.listPendingOps, pending);
    assert.strictEqual(budget.remaining, 500);
  }).pipe(Effect.provide(runtime(adapter)));
});

it.effect("Gmail draft with a pending saveDraft survives a sweep 404", () => {
  const server = fakeServer("me@example.test");
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    verifyResetCandidates: (_account, candidates) =>
      Effect.succeed(candidates.map((c) => ({ kind: "gone" as const, id: c.providerId }))),
  };
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", server.email);
    yield* store.upsertMessage(account.id, message("one", ["DRAFT"]));
    yield* store.putDraft({ id: "editing", accountId: account.id, message: draft });
    yield* store.setDraftRemote("editing", { draftId: "remote-draft", messageId: "one" }, null);
    yield* store.enqueueOp(account.id, "editing", { kind: "saveDraft", draftId: "editing" });
    const pending = yield* store.listPendingOps;
    const guard = makeResetGuard(
      store,
      adapter,
      account,
      { changed: 0, deleted: 0 },
      { remaining: 500 },
    );
    yield* guard.sweep(() => staleHealth("gmail", "DRAFT", 1));
    assert.strictEqual(yield* store.messageIdForProvider(account.id, "one"), null);
    assert.deepStrictEqual(Option.getOrThrow(yield* store.getDraft("editing")).message, draft);
    assert.deepStrictEqual(yield* store.listPendingOps, pending);
  }).pipe(Effect.provide(runtime(adapter)));
});

it.effect("one account's 500-id stale sweep cannot starve another account's reset queue", () => {
  const server = fakeServer("me@example.test");
  const checked: { account: string; count: number }[] = [];
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(server),
    pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
    verifyResetCandidates: (account, candidates) =>
      Effect.sync(() => {
        checked.push({ account: account.id, count: candidates.length });
        return candidates.map((c) => ({
          kind: "present" as const,
          id: c.providerId,
          providerId: c.providerId,
          labels: ["INBOX"],
        }));
      }),
  };
  return Effect.gen(function* () {
    const store = yield* Store,
      mailbox = yield* Mailbox;
    const first = yield* store.upsertAccount("gmail", server.email);
    const second = yield* store.upsertAccount("gmail", "second@example.test");
    for (let n = 0; n < 501; n++)
      yield* store.upsertMessage(first.id, message(`stale${n}`, ["INBOX"]));
    yield* store.upsertMessage(second.id, message("reset", ["INBOX"]));
    yield* store.saveResetCandidates(second.id, [
      { providerId: "reset", rfcMessageId: null, labels: ["INBOX"] },
    ]);
    yield* mailbox.sync();
    // Accounts sync concurrently; each gets its own verification.
    assert.deepStrictEqual(
      checked.toSorted((a, b) => b.count - a.count),
      [
        { account: first.id, count: 500 },
        { account: second.id, count: 1 },
      ],
    );
    assert.deepStrictEqual(yield* store.pendingResetCandidates(second.id), []);
  }).pipe(Effect.provide(runtime(adapter)));
});

for (const provider of ["gmail", "outlook"] satisfies Provider[]) {
  it.effect(
    `${provider} confirmed-present rows complete verification and skip unchanged hourly sweeps`,
    () => {
      const scope = provider === "gmail" ? "CATEGORY_PERSONAL" : "DRAFT";
      const server = fakeServer("me@example.test", [message("m1", [scope])]);
      let checked = 0;
      const logs: unknown[] = [];
      const adapter: ProviderAdapter = {
        ...makeFakeProvider(server),
        pull: () => Stream.succeed({ _tag: "Cursor", cursor: "1" }),
        folderStatus: () =>
          Effect.succeed({ total: 0, unread: 0, threads: 0, uidNext: null, uidValidity: null }),
        verifyResetCandidates: (_account, candidates) =>
          Effect.sync(() => {
            checked += candidates.length;
            return candidates.map((c) => ({
              kind: "present" as const,
              id: c.providerId,
              providerId: c.providerId,
              labels: [scope],
            }));
          }),
      };
      const logger = Logger.make((options) => {
        logs.push(...(Array.isArray(options.message) ? options.message : [options.message]));
      });
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount(provider, server.email);
        yield* store.upsertMessage(account.id, message("m1", [scope]));
        yield* mailbox.sync(account.id);
        const diagnostic = logs.find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "phase" in value &&
            value.phase === "verification",
        );
        assert.ok(diagnostic && typeof diagnostic === "object" && "incomplete" in diagnostic);
        assert.strictEqual(diagnostic.incomplete, 0);
        yield* TestClock.adjust("1 hour");
        yield* mailbox.sync(account.id);
        assert.strictEqual(checked, 1);
        yield* TestClock.adjust("24 hours");
        yield* mailbox.sync(account.id);
        assert.strictEqual(checked, 2);
      }).pipe(Effect.provide(runtime(adapter)), Effect.provide(Logger.layer([logger])));
    },
  );
}

it.effect(
  "verified fingerprints survive guard reconstruction and changed labels are rechecked",
  () => {
    let checked = 0;
    const adapter: ProviderAdapter = {
      ...makeFakeProvider(fakeServer("me@example.test")),
      verifyResetCandidates: (_account, candidates) =>
        Effect.sync(() => {
          checked += candidates.length;
          return candidates.map((candidate) => ({
            kind: "present" as const,
            id: candidate.providerId,
            providerId: candidate.providerId,
            labels: candidate.labels,
          }));
        }),
    };
    return Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.test");
      yield* store.upsertMessage(account.id, message("m1", ["INBOX"]));
      const sweep = () =>
        makeResetGuard(
          store,
          adapter,
          account,
          { changed: 0, deleted: 0 },
          { remaining: 500 },
        ).sweep(() => staleHealth("gmail", "INBOX", 1));
      yield* sweep();
      yield* TestClock.adjust("1 hour");
      yield* sweep();
      assert.strictEqual(checked, 1);
      yield* store.upsertMessage(account.id, {
        ...message("m1", ["INBOX", "STARRED"]),
        isStarred: true,
      });
      yield* TestClock.adjust("1 hour");
      yield* sweep();
      assert.strictEqual(checked, 2);
      const state = yield* store.claimStaleSweep(
        account.id,
        (yield* Clock.currentTimeMillis) + 3_600_000,
      );
      assert.ok(Option.isSome(state));
      assert.ok(Object.keys(state.value.verified ?? {}).every((key) => /^[a-f0-9]{16}$/.test(key)));
    }).pipe(Effect.provide(runtime(adapter)));
  },
);

it.effect("cached remote draft candidates do not trigger another drafts listing", () => {
  let listings = 0;
  let verifications = 0;
  const adapter: ProviderAdapter = {
    ...makeFakeProvider(fakeServer("me@example.test")),
    draftMessageIds: () =>
      Effect.sync(() => {
        listings++;
        return [];
      }),
    verifyResetCandidates: (_account, candidates) =>
      Effect.sync(() => {
        verifications++;
        return candidates.map((candidate) => ({
          kind: "present" as const,
          id: candidate.providerId,
          providerId: candidate.providerId,
          labels: ["DRAFT"],
        }));
      }),
  };
  return Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("gmail", "me@example.test");
    yield* store.putDraft({ id: "orphan", accountId: account.id, message: draft });
    yield* store.setDraftRemote("orphan", { draftId: "remote", messageId: "remote-message" }, null);
    const sweep = () =>
      makeResetGuard(store, adapter, account, { changed: 0, deleted: 0 }, { remaining: 500 }).sweep(
        () => staleHealth("gmail", "DRAFT", 1),
      );
    yield* sweep();
    assert.strictEqual(listings, 1);
    assert.strictEqual(verifications, 1);
    yield* TestClock.adjust("1 hour");
    yield* sweep();
    assert.strictEqual(listings, 1);
    assert.strictEqual(verifications, 1);
  }).pipe(Effect.provide(runtime(adapter)));
});
