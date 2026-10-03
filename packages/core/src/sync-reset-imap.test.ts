import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import { ImapFlow } from "imapflow";
import { vi } from "vitest";
import type { IncomingMessage } from "./domain.js";
import { Store } from "./services.js";
import { StoreLive } from "./store.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { makeImapWith } from "./platform/node/imap.js";
import { makeResetGuard } from "./sync-reset.js";
import { readCursor, parseUidSet } from "./imap-cursor.js";
const settings = {
  preset: "custom",
  username: "me@example.test",
  imapHost: "fake.invalid",
  imapPort: 993,
  smtpHost: "fake.invalid",
  smtpPort: 465,
  smtpSecure: true,
} as const;
const message = (uid: number, validity = "7"): IncomingMessage => ({
  providerId: `${validity}:${uid}:INBOX`,
  rfcMessageId: `<m${uid}@example.test>`,
  threadId: `m${uid}`,
  subject: "Cached",
  from: { name: "", address: "sender@example.test" },
  to: [],
  cc: [],
  date: 1000,
  snippet: "cached",
  bodyText: "cached body",
  bodyHtml: "",
  labels: ["INBOX", "UNREAD"],
  attachments: [],
  isUnread: true,
  isStarred: false,
});
for (const outcome of ["present", "gone", "moved", "failed"] as const)
  for (const oldValidity of ["7", "6"]) {
    it.effect(`slice56: IMAP reset ${oldValidity} verifies ${outcome} by UID and Message-ID`, () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("imap", "me@example.test");
        yield* store.setImapSettings(account.id, settings);
        const owner = { ...account, imap: settings };
        for (let uid = 1; uid <= 100; uid++)
          yield* store.upsertMessage(account.id, message(uid, oldValidity));
        yield* store.saveSyncCursor(
          account.id,
          JSON.stringify({
            folders: {
              INBOX: { uidValidity: "7", lastUid: 100, uids: "1:10", unread: "1:10", starred: "" },
              Archive: { uidValidity: "7", lastUid: 0, uids: "", unread: "", starred: "" },
            },
          }),
        );
        const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
        let selected = "";
        vi.spyOn(client, "list").mockResolvedValue(
          ["INBOX", "Archive"].map((path) => ({
            path,
            name: path,
            pathAsListed: path,
            parent: [],
            parentPath: "",
            delimiter: "/",
            flags: new Set<string>(),
            listed: true,
            subscribed: true,
            specialUse: path === "INBOX" ? "\\Inbox" : "\\Archive",
          })),
        );
        vi.spyOn(client, "mailboxOpen").mockImplementation(async (path) => {
          selected = typeof path === "string" ? path : path.join("/");
          return {
            path: selected,
            delimiter: "/",
            flags: new Set<string>(),
            uidValidity: 7n,
            uidNext: 101,
            exists: 100,
          };
        });
        const search = vi.spyOn(client, "search").mockImplementation(async (query) => {
          if (outcome === "failed") return false;
          if (typeof query === "string") throw new Error("Unexpected search string");
          if (query.uid) return outcome === "present" ? parseUidSet(String(query.uid)) : [];
          const id = query.header?.["message-id"] ?? "";
          const uid = Number(/m(\d+)@/.exec(String(id))?.[1]);
          return (outcome === "present" && selected === "INBOX") ||
            (outcome === "moved" && selected === "Archive")
            ? [uid]
            : [];
        });
        const adapter = yield* makeImapWith(() =>
          Effect.succeed({ accountId: owner.id, settings, client }),
        );
        const counts = { changed: 0, deleted: 0 };
        const guard = makeResetGuard(store, adapter, owner, counts, { remaining: 500 });
        const keep = Array.from(
          { length: 10 },
          (_value, index) => `${oldValidity}:${index + 1}:INBOX`,
        );
        yield* guard.reset({
          _tag: "RebuildFolder",
          previous: { path: "INBOX", uidValidity: oldValidity },
          keep,
        });
        yield* guard.verify();
        assert.strictEqual(
          yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          outcome === "gone" ? 10 : 100,
        );
        assert.strictEqual(
          (yield* store.pendingResetCandidates(account.id)).length,
          outcome === "failed" ? 90 : 0,
        );
        if (outcome === "moved") {
          const id = yield* store.messageIdForProvider(account.id, "7:11:Archive");
          assert.ok(id);
          const local = yield* store.getMessage(id);
          assert.deepStrictEqual(local.labels, ["ARCHIVE", "UNREAD"]);
          assert.strictEqual(local.bodyText, "cached body");
        }
        if (outcome === "present") {
          const cursor = readCursor(yield* store.getSyncCursor(account.id));
          assert.strictEqual(parseUidSet(cursor.folders.INBOX?.uids ?? "").length, 100);
        }
        assert.ok(search.mock.calls.length > 0);
      }).pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provideMerge(MemoryPlatform({ secrets: { "imap:me@example.test": "password" } })),
          ),
        ),
      ),
    );
  }

it.effect(
  "slice56: IMAP flag sweep emits one bounded reset barrier instead of individual deletes",
  () =>
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.test");
      const owner = { ...account, imap: settings };
      const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
      vi.spyOn(client, "list").mockResolvedValue([
        {
          path: "INBOX",
          name: "INBOX",
          pathAsListed: "INBOX",
          parent: [],
          parentPath: "",
          delimiter: "/",
          flags: new Set<string>(),
          listed: true,
          subscribed: true,
          specialUse: "\\Inbox",
        },
      ]);
      vi.spyOn(client, "mailboxOpen").mockResolvedValue({
        path: "INBOX",
        delimiter: "/",
        flags: new Set<string>(),
        uidValidity: 7n,
        uidNext: 101,
        exists: 100,
      });
      vi.spyOn(client, "search").mockResolvedValue([]);
      vi.spyOn(client, "fetchAll").mockResolvedValue(
        Array.from({ length: 10 }, (_value, index) => ({
          seq: index + 1,
          uid: index + 1,
          flags: new Set<string>(),
          size: 0,
        })),
      );
      const adapter = yield* makeImapWith(() =>
        Effect.succeed({ accountId: owner.id, settings, client }),
      );
      const cursor = Option.some(
        JSON.stringify({
          folders: {
            INBOX: { uidValidity: "7", lastUid: 100, uids: "1:100", unread: "1:100", starred: "" },
          },
        }),
      );
      const changes = yield* Stream.runCollect(adapter.pull(owner, cursor));
      assert.isFalse(changes.some((change) => change._tag === "Delete"));
      const sweep = changes.find((change) => change._tag === "RebuildFolder");
      assert.ok(sweep?._tag === "RebuildFolder");
      assert.strictEqual(sweep.candidates?.length, 90);
    }).pipe(
      Effect.provide(
        StoreLive.pipe(
          Layer.provideMerge(MemoryPlatform({ secrets: { "imap:me@example.test": "password" } })),
        ),
      ),
    ),
);

for (const outcome of ["present", "gone", "moved", "failed", "no-id"] as const) {
  it.effect(
    `slice56: invalidated UID namespace preserves cached mail until ${outcome} is verified`,
    () =>
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("imap", "me@example.test");
        yield* store.setImapSettings(account.id, settings);
        const owner = { ...account, imap: settings };
        for (let uid = 1; uid <= 100; uid++) {
          const incoming = message(uid);
          yield* store.upsertMessage(
            account.id,
            outcome === "no-id" ? { ...incoming, rfcMessageId: undefined } : incoming,
          );
        }
        yield* store.enqueueOp(account.id, "7:11:INBOX", { kind: "trash" });
        yield* store.invalidateImapFolder(account.id, { path: "INBOX", uidValidity: "7" });
        assert.strictEqual(
          yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          100,
        );
        const pending = yield* store.pendingResetCandidates(account.id);
        assert.strictEqual(pending.length, 100);
        assert.isTrue(pending.some((candidate) => candidate.resetProviderId === "7:1:INBOX"));
        assert.isNull(yield* store.messageIdForProvider(account.id, "7:11:INBOX"));
        assert.isTrue((yield* store.listPendingOps).every((op) => op.op.kind === "reconcile"));
        for (let uid = 1; uid <= 10; uid++)
          yield* store.upsertMessage(account.id, {
            ...message(uid),
            rfcMessageId: `<replacement${uid}@example.test>`,
            bodyText: "new UID occupant",
          });
        if (outcome === "present")
          yield* store.upsertMessage(account.id, {
            ...message(11),
            providerId: "7:111:INBOX",
            labels: ["INBOX"],
            isUnread: false,
            bodyText: "fresh verified body",
          });
        const client = new ImapFlow({ host: "fake.invalid", port: 993, logger: false });
        let selected = "";
        vi.spyOn(client, "list").mockResolvedValue(
          ["INBOX", "Archive"].map((path) => ({
            path,
            name: path,
            pathAsListed: path,
            parent: [],
            parentPath: "",
            delimiter: "/",
            flags: new Set<string>(),
            listed: true,
            subscribed: true,
            specialUse: path === "INBOX" ? "\\Inbox" : "\\Archive",
          })),
        );
        vi.spyOn(client, "mailboxOpen").mockImplementation(async (path) => {
          selected = String(path);
          return {
            path: selected,
            delimiter: "/",
            flags: new Set<string>(),
            uidValidity: 7n,
            uidNext: 201,
            exists: 100,
          };
        });
        const search = vi.spyOn(client, "search").mockImplementation(async (query) => {
          if (outcome === "failed") return false;
          if (typeof query === "string") throw new Error("Unexpected search string");
          // A reused UID can exist while pointing at a different message. Never trust it here.
          if (query.uid) throw new Error("Unsafe UID verification after invalidation");
          const uid = Number(/m(\d+)@/.exec(String(query.header?.["message-id"]))?.[1]);
          return (outcome === "present" && selected === "INBOX") ||
            (outcome === "moved" && selected === "Archive")
            ? [uid + 100]
            : [];
        });
        const adapter = yield* makeImapWith(() =>
          Effect.succeed({ accountId: owner.id, settings, client }),
        );
        yield* makeResetGuard(
          store,
          adapter,
          owner,
          { changed: 0, deleted: 0 },
          { remaining: 500 },
        ).verify();
        assert.strictEqual(
          yield* store.countThreads({ accountIds: [account.id], mailbox: "all", flat: true }),
          outcome === "gone" ? 10 : 110,
        );
        assert.strictEqual(
          (yield* store.pendingResetCandidates(account.id)).length,
          outcome === "failed" || outcome === "no-id" ? 100 : 0,
        );
        const replacement = yield* store.messageIdForProvider(account.id, "7:1:INBOX");
        assert.ok(replacement);
        assert.strictEqual((yield* store.getMessage(replacement)).bodyText, "new UID occupant");
        if (outcome === "present" || outcome === "moved") {
          const restored = yield* store.messageIdForProvider(
            account.id,
            `7:111:${outcome === "moved" ? "Archive" : "INBOX"}`,
          );
          assert.ok(restored);
          assert.notStrictEqual(restored, `${account.id}/7:11:INBOX`);
          assert.isFalse(yield* store.hasMessage(`${account.id}/7:11:INBOX`));
          const verified = yield* store.getMessage(restored);
          assert.strictEqual(
            verified.bodyText,
            outcome === "present" ? "fresh verified body" : "cached body",
          );
          if (outcome === "present") assert.isFalse(verified.isUnread);
        }
        if (outcome === "no-id") assert.strictEqual(search.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          StoreLive.pipe(
            Layer.provideMerge(MemoryPlatform({ secrets: { "imap:me@example.test": "password" } })),
          ),
        ),
      ),
  );
}

it.effect("slice56: IMAP rebuilt window never includes old headers in deletion candidates", () =>
  Effect.gen(function* () {
    const store = yield* Store;
    const account = yield* store.upsertAccount("imap", "me@example.test");
    const adapter = yield* makeImapWith(() => Effect.die("No verification network call expected"));
    yield* store.upsertMessage(account.id, { ...message(1, "6"), date: -10000000000 });
    yield* store.upsertMessage(account.id, message(2, "6"));
    const counts = { changed: 0, deleted: 0 };
    const guard = makeResetGuard(store, adapter, { ...account, imap: settings }, counts, {
      remaining: 500,
    });
    yield* guard.reset({
      _tag: "RebuildFolder",
      previous: { path: "INBOX", uidValidity: "6" },
      keep: [],
      since: 0,
      partial: true,
    });
    assert.isTrue(yield* store.hasMessage(`${account.id}/6:1:INBOX`));
    assert.isTrue(yield* store.hasMessage(`${account.id}/6:2:INBOX`));
    assert.deepStrictEqual(
      (yield* store.pendingResetCandidates(account.id)).map((candidate) => candidate.providerId),
      ["6:2:INBOX"],
    );
  }).pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(MemoryPlatform())))),
);
