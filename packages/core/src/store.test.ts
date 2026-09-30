import { load } from "sqlite-vec";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";

import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";

import { databaseLayer, MIGRATIONS, splitStatements } from "./db.js";
import type { Actor, Command, IncomingMessage } from "./domain.js";
import { MemoryFileSystem, MemoryPlatform } from "./platform-memory.js";
import { Store } from "./services.js";
import { applyOpToLabels, folderTarget, StoreLive } from "./store.js";

function message(overrides: Partial<IncomingMessage>): IncomingMessage {
  return {
    providerId: "m1",
    threadId: "t1",
    subject: "季度报告",
    from: { name: "Alice", address: "alice@example.com" },
    to: [],
    cc: [],
    date: 1_000,
    snippet: "",
    bodyText: "附件是第三季度的产能数据",
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: true,
    isStarred: false,
    ...overrides,
  };
}

/**
 * Runs `body` against a fresh in-memory database. Not a shared `layer(...)`:
 * each test counts rows and expects to start empty.
 */
const withStore = <A, E>(
  body: Effect.Effect<A, E, Store | SqlClient.SqlClient>,
  sqlLayer: Layer.Layer<SqlClient.SqlClient> = MemoryPlatform(),
) => body.pipe(Effect.provide(StoreLive.pipe(Layer.provideMerge(sqlLayer))));

const Row = Schema.Struct({ rowid: Schema.Number });

it.effect("lists by mailbox and searches Chinese of any length", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "Me@Example.com");
      assert.strictEqual(id, "gmail:me@example.com");
      yield* store.upsertMessage(id, message({}));
      yield* store.upsertMessage(
        id,
        message({
          providerId: "m2",
          threadId: "t2",
          subject: "Invoice",
          bodyText: "pay",
          labels: ["SENT"],
          date: 2_000,
          from: { name: "Bob", address: "bob@example.com" },
        }),
      );

      const subjects = (threads: readonly { subject: string }[]) => threads.map((t) => t.subject);
      assert.deepStrictEqual(subjects(yield* store.listThreads({})), ["季度报告"]);
      assert.deepStrictEqual(subjects(yield* store.listThreads({ mailbox: "all" })), [
        "Invoice",
        "季度报告",
      ]);
      const search = (text: string) => store.listThreads({ search: text });
      assert.strictEqual((yield* search("产能数据")).length, 1);
      assert.strictEqual((yield* search("季度")).length, 1);
      assert.strictEqual((yield* search("季度 invoice")).length, 0);
      assert.strictEqual((yield* search("alice")).length, 1);
      assert.strictEqual((yield* search("   ")).length, 0);
      // Search ignores the mailbox and returns each hit as its own row.
      const [hit] = yield* store.listThreads({ search: "Invoice", mailbox: "inbox" });
      assert.ok(hit);
      assert.strictEqual(hit.threadCount, 1);
      assert.deepStrictEqual(hit.participants, [{ name: "Bob", address: "bob@example.com" }]);
      assert.strictEqual((yield* store.listThreads({ search: "pay", accountIds: [] })).length, 0);
    }),
  ),
);

it.effect("an upsert keeps the rowid, so the FTS index follows the update", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      const rowid = Effect.flatMap(
        sql`SELECT rowid FROM messages WHERE id = ${`${id}/m1`}`,
        Schema.decodeUnknownEffect(Schema.Array(Row)),
      );

      yield* store.upsertMessage(id, message({}));
      yield* store.upsertMessage(
        id,
        message({ providerId: "m2", threadId: "t2", subject: "别的", bodyText: "无关" }),
      );
      const before = yield* rowid;
      yield* store.upsertMessage(
        id,
        message({ subject: "月度总结", bodyText: "更新后的正文内容" }),
      );
      assert.deepStrictEqual(yield* rowid, before);

      const search = (text: string) => store.listThreads({ search: text });
      assert.strictEqual((yield* search("季度报告")).length, 0);
      assert.deepStrictEqual(
        (yield* search("更新后的")).map((t) => t.subject),
        ["月度总结"],
      );
      assert.strictEqual((yield* store.getThread(`${id}/m1`)).length, 1);
      // Fails if any index row points at a stale or missing message.
      yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`;

      yield* store.deleteMessage(id, "m1");
      assert.strictEqual((yield* search("更新后的")).length, 0);
      yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`;
    }),
  ),
);

it.effect("threads collapse to their newest message and roll up unread", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(id, message({ providerId: "a", date: 1, isUnread: true }));
      yield* store.upsertMessage(
        id,
        message({
          providerId: "b",
          date: 2,
          isUnread: false,
          labels: ["INBOX"],
          from: { name: "Bob", address: "bob@example.com" },
        }),
      );
      yield* store.upsertMessage(
        id,
        message({ providerId: "c", threadId: "t2", date: 3, subject: "新会话" }),
      );

      const threads = yield* store.listThreads({});
      assert.deepStrictEqual(
        threads.map((t) => [t.subject, t.threadCount, t.isUnread]),
        [
          ["新会话", 1, true],
          ["季度报告", 2, true],
        ],
      );
      assert.deepStrictEqual(
        threads[1]?.participants.map((p) => p.name),
        ["Alice", "Bob"],
      );
      // Paging by the newest date never repeats a thread.
      assert.deepStrictEqual(
        (yield* store.listThreads({ before: 3 })).map((t) => t.threadId),
        ["t1"],
      );
      assert.strictEqual((yield* store.listThreads({ before: 2 })).length, 0);
      assert.deepStrictEqual(yield* store.threadMessageIds(`${id}/b`), [`${id}/a`, `${id}/b`]);

      // Grouping off: every message is a row, and paging goes by message date.
      const flat = yield* store.listThreads({ flat: true });
      assert.deepStrictEqual(
        flat.map((t) => [t.id, t.threadCount, t.isUnread]),
        [
          [`${id}/c`, 1, true],
          [`${id}/b`, 1, false],
          [`${id}/a`, 1, true],
        ],
      );
      assert.deepStrictEqual(
        (yield* store.listThreads({ flat: true, before: 2 })).map((t) => t.id),
        [`${id}/a`],
      );
      assert.deepStrictEqual(
        (yield* store.listThreads({ flat: true, unreadOnly: true })).map((t) => t.id),
        [`${id}/c`, `${id}/a`],
      );
    }),
  ),
);

it.effect("all mail skips spam and trash; profiles scope accounts", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const work = yield* store.upsertAccount("gmail", "work@example.com");
      const home = yield* store.upsertAccount("outlook", "home@example.com");
      yield* store.upsertMessage(work.id, message({ providerId: "w1" }));
      yield* store.upsertMessage(
        work.id,
        message({ providerId: "w2", threadId: "t2", labels: ["SPAM", "UNREAD"] }),
      );
      yield* store.upsertMessage(
        home.id,
        message({ providerId: "h1", labels: ["INBOX", "Label_1", "UNREAD"] }),
      );

      assert.strictEqual((yield* store.listThreads({ mailbox: "all" })).length, 2);
      assert.strictEqual((yield* store.listThreads({ mailbox: "spam" })).length, 1);
      assert.strictEqual(
        (yield* store.listThreads({ mailbox: "all", label: "Label_1" })).length,
        1,
      );

      const profile = yield* store.createProfile({ name: "工作", icon: "💼", color: "blue" });
      assert.strictEqual(profile.position, 0);
      yield* store.setAccountProfile(work.id, profile.id);
      assert.deepStrictEqual(
        (yield* store.listAccounts).map((a) => a.profileId),
        [profile.id, null],
      );
      assert.strictEqual((yield* store.listThreads({ accountIds: [work.id] })).length, 1);
      assert.strictEqual((yield* store.listThreads({ accountIds: [] })).length, 0);
      assert.deepStrictEqual(yield* store.unreadByLabel([work.id]), {
        INBOX: 1,
        SPAM: 1,
        UNREAD: 2,
      });
      assert.deepStrictEqual(yield* store.unreadByLabel(undefined, "INBOX"), {
        INBOX: 2,
        Label_1: 1,
        UNREAD: 2,
      });
      assert.deepStrictEqual(yield* store.unreadCounts, { [work.id]: 1, [home.id]: 1 });

      yield* store.updateProfile(profile.id, { name: "公司", icon: "🏢", color: "teal" });
      assert.deepStrictEqual(yield* store.listProfiles, [
        { id: profile.id, name: "公司", icon: "🏢", color: "teal", position: 0 },
      ]);
      yield* store.deleteProfile(profile.id);
      assert.strictEqual((yield* store.listAccounts)[0]?.profileId, null);
    }),
  ),
);

it.effect("accounts keep sync state, IMAP settings and labels", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("imap", "me@example.com");
      // Re-adding returns the same account.
      assert.strictEqual((yield* store.upsertAccount("imap", "ME@example.com")).id, id);
      assert.strictEqual((yield* store.getSyncCursor(id))._tag, "None");
      yield* store.saveSyncCursor(id, "c1");
      assert.deepStrictEqual(yield* store.getSyncCursor(id), yield* Effect.succeedSome("c1"));
      const imap = {
        preset: "custom",
        username: "me",
        imapHost: "imap.example.com",
        imapPort: 993,
        smtpHost: "smtp.example.com",
        smtpPort: 465,
        smtpSecure: true,
      };
      yield* store.setImapSettings(id, imap);
      yield* store.setNeedsReauth(id, true);
      yield* store.setSyncError(id, "offline");
      const account = yield* store.getAccount(id);
      assert.deepStrictEqual(account.imap, imap);
      assert.strictEqual(account.needsReauth, true);
      assert.strictEqual(account.lastSyncError, "offline");
      assert.strictEqual(typeof account.lastSyncedAt, "number");

      yield* store.replaceLabels(id, [
        { id: "b", name: "Beta", color: null },
        { id: "a", name: "Alpha", color: "#fff" },
      ]);
      yield* store.replaceLabels(id, [{ id: "a", name: "Alpha", color: "#fff" }]);
      assert.deepStrictEqual(yield* store.listLabels(), [
        { accountId: id, id: "a", name: "Alpha", color: "#fff" },
      ]);
      assert.deepStrictEqual(yield* store.listLabels([]), []);

      yield* store.upsertMessage(id, message({ labels: ["Folder"] }));
      yield* store.upsertMessage(id, message({ providerId: "m2", labels: ["INBOX"] }));
      yield* store.deleteMessagesWithLabel(id, "Folder");
      assert.deepStrictEqual(yield* store.messageLabels(id, "m2"), ["INBOX"]);
      assert.deepStrictEqual(yield* store.messageLabels(id, "m1"), []);
      yield* store.deleteAccountMessages(id);
      assert.strictEqual((yield* store.listThreads({ mailbox: "all" })).length, 0);

      yield* store.removeAccount(id);
      const missing = yield* Effect.flip(store.getAccount(id));
      assert.strictEqual(missing._tag, "NotFound");
    }),
  ),
);

it.effect("missing messages and proposals are NotFound", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const missing = yield* Effect.flip(store.getMessage("x/y"));
      assert.strictEqual(missing._tag, "NotFound");
      assert.strictEqual(missing.what, "message");
      assert.strictEqual(missing.id, "x/y");
      assert.strictEqual((yield* Effect.flip(store.getThread("x/y")))._tag, "NotFound");
      assert.strictEqual((yield* Effect.flip(store.messageRef("x/y")))._tag, "NotFound");
      assert.strictEqual((yield* Effect.flip(store.getProposal(42))).what, "proposal");
      assert.deepStrictEqual(yield* store.threadMessageIds("x/y"), []);
      // Nothing to change is not an error.
      yield* store.applyLocalOp("x/y", { kind: "archive" });
    }),
  ),
);

it("gmail labels stack; folder providers swap the folder", () => {
  const inbox = ["INBOX", "UNREAD", "Label_1"];
  assert.deepStrictEqual(applyOpToLabels(inbox, { kind: "archive" }, "gmail").toSorted(), [
    "Label_1",
    "UNREAD",
  ]);
  assert.deepStrictEqual(applyOpToLabels(["INBOX", "SPAM"], { kind: "inbox" }, "gmail"), ["INBOX"]);
  assert.deepStrictEqual(applyOpToLabels(["INBOX"], { kind: "trash" }, "gmail"), ["TRASH"]);
  assert.deepStrictEqual(applyOpToLabels(["UNREAD"], { kind: "read", value: true }, "gmail"), []);
  assert.deepStrictEqual(
    applyOpToLabels(["INBOX", "UNREAD"], { kind: "archive" }, "outlook").toSorted(),
    ["ARCHIVE", "UNREAD"],
  );
  assert.deepStrictEqual(
    applyOpToLabels(["TRASH", "STARRED"], { kind: "inbox" }, "imap").toSorted(),
    ["INBOX", "STARRED"],
  );
  assert.deepStrictEqual(
    applyOpToLabels(["INBOX"], { kind: "label", labelId: "f1", value: true }, "outlook"),
    ["f1"],
  );
  // Important has no folder equivalent.
  assert.deepStrictEqual(
    applyOpToLabels(["INBOX"], { kind: "important", value: true }, "outlook"),
    ["INBOX"],
  );
  assert.strictEqual(folderTarget({ kind: "label", labelId: "f1", value: false }, ["INBOX"]), null);
  assert.strictEqual(folderTarget({ kind: "label", labelId: "f1", value: false }, ["f1"]), "INBOX");
  assert.strictEqual(folderTarget({ kind: "star", value: true }, ["INBOX"]), null);
});

it.effect("local ops update flags; the queue keeps order and counts attempts", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("outlook", "a@example.com");
      yield* store.upsertMessage(account.id, message({ providerId: "p1" }));
      const id = `${account.id}/p1`;
      yield* store.applyLocalOp(id, { kind: "read", value: true });
      yield* store.applyLocalOp(id, { kind: "star", value: true });
      yield* store.applyLocalOp(id, { kind: "archive" });
      const m = yield* store.getMessage(id);
      assert.strictEqual(m.isUnread, false);
      assert.strictEqual(m.isStarred, true);
      assert.deepStrictEqual(m.labels.toSorted(), ["ARCHIVE", "STARRED"]);
      assert.deepStrictEqual(yield* store.messageRef(id), {
        accountId: account.id,
        providerId: "p1",
      });

      yield* store.enqueueOp(account.id, "p1", { kind: "read", value: true });
      yield* store.enqueueOp(account.id, "p1", { kind: "archive" });
      const [first, second] = yield* store.listPendingOps;
      assert.ok(first && second);
      assert.deepStrictEqual(first.op, { kind: "read", value: true });
      yield* store.failPendingOp(first.id, "offline");
      const [failed] = yield* store.listPendingOps;
      assert.ok(failed);
      assert.strictEqual(failed.attempts, 1);
      assert.strictEqual(failed.lastError, "offline");
      yield* store.removePendingOp(first.id);
      assert.deepStrictEqual(
        (yield* store.listPendingOps).map((p) => p.id),
        [second.id],
      );

      yield* store.audit({
        actor: { kind: "agent", surface: "mcp", name: "claude" },
        accountId: account.id,
        action: "archive",
        detail: { id },
      });
      yield* store.audit({
        actor: { kind: "user", surface: "cli" },
        action: "sync",
        detail: undefined,
      });
      const [latest, earlier] = yield* store.listAudit(10);
      assert.ok(latest && earlier);
      assert.strictEqual(latest.actor, "user:cli");
      assert.strictEqual(latest.accountId, null);
      assert.strictEqual(latest.detail, null);
      assert.strictEqual(earlier.actor, "agent:mcp:claude");
      assert.deepStrictEqual(earlier.detail, { id });
      assert.strictEqual((yield* store.listAudit(1)).length, 1);
    }),
  ),
);

it.effect("agent policy falls back to '*' then off; proposals round-trip", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      assert.strictEqual(yield* store.agentWriteMode("claude"), "off");
      yield* store.setAgentWriteMode("*", "propose");
      assert.strictEqual(yield* store.agentWriteMode("claude"), "propose");
      yield* store.setAgentWriteMode("claude", "allow");
      assert.strictEqual(yield* store.agentWriteMode("claude"), "allow");
      assert.strictEqual(yield* store.agentWriteMode("other"), "propose");

      const agent: Actor = { kind: "agent", surface: "mcp", name: "claude", rationale: "回复客户" };
      const send: Command = {
        kind: "send",
        accountId: "gmail:a@example.com",
        message: { to: [], cc: [], bcc: [], subject: "Re", text: "收到", attachments: [] },
      };
      const archive: Command = { kind: "modify", threads: ["x"], op: { kind: "archive" } };
      const a = yield* store.insertProposal(agent, send);
      const b = yield* store.insertProposal(agent, archive);
      assert.notStrictEqual(a, b);

      const pending = yield* store.listProposals("pending");
      assert.deepStrictEqual(
        pending.map((p) => p.id),
        [a, b],
      );
      const [oldest] = pending;
      assert.ok(oldest);
      assert.deepStrictEqual(oldest.actor, agent);
      assert.deepStrictEqual(oldest.command, send);
      assert.strictEqual(oldest.status, "pending");

      yield* store.setProposalStatus(a, "rejected");
      // A decided proposal keeps its first decision.
      yield* store.setProposalStatus(a, "approved");
      assert.strictEqual((yield* store.getProposal(a)).status, "rejected");
      assert.deepStrictEqual(
        (yield* store.listProposals("pending")).map((p) => p.id),
        [b],
      );
      assert.strictEqual((yield* store.listProposals("rejected")).length, 1);
    }),
  ),
);

it.effect("a failed transaction rolls back every write in it", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      const exit = yield* Effect.exit(
        store.transaction(
          Effect.gen(function* () {
            yield* store.upsertMessage(id, message({}));
            yield* store.replaceLabels(id, [{ id: "a", name: "A", color: null }]);
            return yield* Effect.fail("boom");
          }),
        ),
      );
      assert.ok(Exit.isFailure(exit));
      assert.strictEqual((yield* store.listThreads({ mailbox: "all" })).length, 0);
      assert.strictEqual((yield* store.listLabels()).length, 0);
    }),
  ),
);

it.effect("split migrations build the same schema as running each script whole", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const Master = Schema.Array(
      Schema.Struct({
        type: Schema.String,
        name: Schema.String,
        sql: Schema.NullOr(Schema.String),
      }),
    );
    const ours = yield* Effect.flatMap(
      sql`SELECT type, name, sql FROM sqlite_master ORDER BY name`,
      Schema.decodeUnknownEffect(Master),
    );

    const reference = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const db = new DatabaseSync(":memory:", { allowExtension: true });
        load(db);
        db.enableLoadExtension(false);
        return db;
      }),
      (db) => Effect.sync(() => db.close()),
    );
    for (const migration of MIGRATIONS) reference.exec(migration);
    reference.exec(
      "CREATE VIRTUAL TABLE derived_text_vectors USING vec0(embedding float[384]); CREATE VIRTUAL TABLE derived_image_vectors USING vec0(embedding float[512]);",
    );
    const expected = yield* Schema.decodeUnknownEffect(Master)(
      reference.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all(),
    );
    assert.deepStrictEqual(ours, expected);

    // Triggers stay whole; comments and quoted semicolons do not split.
    assert.strictEqual(splitStatements(MIGRATIONS[0]!).length, 9);
    assert.deepStrictEqual(splitStatements("-- a; b\nSELECT ';'; /* ; */ SELECT 2;"), [
      "-- a; b\nSELECT ';';",
      "/* ; */ SELECT 2;",
    ]);
  }).pipe(
    Effect.provide(databaseLayer(":memory:")),
    Effect.provide(Layer.mergeAll(MemoryFileSystem(), Path.layer)),
  ),
);

// On the real disk: the test is about a database file an older build left behind.
it.effect("a database from an older version migrates without losing mail", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-db-" });
    const file = path.join(dir, "nested", "mail.db");

    // Build a version-3 database the way the old openDb did.
    yield* fs.makeDirectory(path.dirname(file));
    yield* Effect.sync(() => {
      const old = new DatabaseSync(file);
      old.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
      for (const migration of MIGRATIONS.slice(0, 3)) old.exec(migration);
      old.exec("PRAGMA user_version = 3");
      old.exec(`INSERT INTO accounts (id, provider, email, created_at, needs_reauth)
        VALUES ('gmail:me@example.com', 'gmail', 'me@example.com', 1, 0)`);
      old.exec(`INSERT INTO messages VALUES ('gmail:me@example.com/m1', 'gmail:me@example.com',
        'm1', 't1', '季度报告', 'Alice', 'alice@example.com', '[]', '[]', 5, '', '产能数据', '',
        '["INBOX","UNREAD"]', '[]', 1, 0)`);
      old.close();
    });

    const check = Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const [version] = yield* sql`PRAGMA user_version`;
      assert.deepStrictEqual({ ...version }, { user_version: MIGRATIONS.length });
      assert.strictEqual((yield* store.listAccounts)[0]?.email, "me@example.com");
      assert.deepStrictEqual(
        (yield* store.listThreads({ search: "产能数据" })).map((t) => t.subject),
        ["季度报告"],
      );
      // Version 4 tables exist and work.
      yield* store.setAgentWriteMode("*", "allow");
      assert.strictEqual(yield* store.agentWriteMode("claude"), "allow");
    });
    const disk = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
    // Twice: the second open finds the database current and changes nothing.
    yield* withStore(check, databaseLayer(file).pipe(Layer.provide(disk)));
    yield* withStore(check, databaseLayer(file).pipe(Layer.provide(disk)));
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);

it.effect("a queued op is pushed by one process at a time; claims expire", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.enqueueOp(id, "m1", { kind: "archive" });
      const [op] = yield* store.listPendingOps;
      assert.ok(op);
      assert.strictEqual(yield* store.claimPendingOp(op.id), true);
      // Another process (the CLI next to the app) finds it taken.
      assert.strictEqual(yield* store.claimPendingOp(op.id), false);
      yield* store.releasePendingOp(op.id);
      assert.strictEqual(yield* store.claimPendingOp(op.id), true);
      // A claim left by a process that died mid-push runs out after two minutes.
      yield* TestClock.adjust("3 minutes");
      assert.strictEqual(yield* store.claimPendingOp(op.id), true);
    }),
  ),
);

it.effect("draft saves coalesce, and a pull only drops drafts with nothing left to push", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      const message = { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] };
      for (const draft of ["draft:a", "draft:b"]) {
        yield* store.putDraft({ id: draft, accountId: id, message });
        yield* store.setDraftRemote(
          draft,
          { draftId: `r-${draft}`, messageId: `m-${draft}` },
          null,
        );
      }
      yield* store.enqueueDraftSave(id, "draft:b");
      yield* store.enqueueDraftSave(id, "draft:b");
      assert.strictEqual((yield* store.listPendingOps).length, 1);

      yield* store.dropSyncedDrafts(id);
      assert.ok(Option.isNone(yield* store.getDraft("draft:a")));
      assert.ok(Option.isSome(yield* store.getDraft("draft:b")));

      // Deleting a draft takes its waiting push with it.
      yield* store.deleteDraft("draft:b");
      assert.deepStrictEqual(yield* store.listPendingOps, []);
      assert.strictEqual(
        yield* store.setDraftRemote("draft:b", { draftId: "x", messageId: "y" }, null),
        false,
      );
    }),
  ),
);

it.effect("local drafts join the Drafts list only for unfiltered views", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(
        id,
        message({ providerId: "d1", labels: ["DRAFT"], date: 5, isUnread: false }),
      );
      yield* store.putDraft({
        id: "draft:a",
        accountId: id,
        message: { to: [], cc: [], bcc: [], subject: "本地", text: "正文", attachments: [] },
      });
      const ids = (list: readonly { id: string }[]) => list.map((t) => t.id);
      assert.deepStrictEqual(ids(yield* store.listThreads({ mailbox: "drafts" })), [
        `${id}/d1`,
        "draft:a",
      ]);
      assert.deepStrictEqual(
        ids(yield* store.listThreads({ mailbox: "drafts", unreadOnly: true })),
        [],
      );
      assert.deepStrictEqual(
        ids(yield* store.listThreads({ mailbox: "drafts", accountIds: [] })),
        [],
      );
      // Linked to the pulled copy: shown once.
      yield* store.setDraftRemote("draft:a", { draftId: null, messageId: "d1" }, null);
      assert.deepStrictEqual(ids(yield* store.listThreads({ mailbox: "drafts" })), [`${id}/d1`]);
    }),
  ),
);

it.effect(
  "reminders, sidebar preferences and Gmail signatures persist after closing and reopening SQLite",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-slice3-test-" });
      const disk = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
      const db = () => databaseLayer(path.join(dir, "mail.db")).pipe(Layer.provide(disk));
      yield* withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          yield* store.upsertMessage(account.id, message({}));
          yield* store.snooze(`${account.id}/m1`, 10_000);
          yield* store.setOrganization({ accountId: account.id, categories: false });
          yield* store.setLabelPreference({
            accountId: account.id,
            id: "Work",
            visible: false,
            favorite: true,
            color: "#4986e7",
          });
          yield* store.transaction(
            store.replaceSendAs(account.id, [
              {
                accountId: account.id,
                address: "alias@example.com",
                name: "Alias",
                isDefault: true,
                signature: "Hello",
              },
            ]),
          );
        }),
        db(),
      );
      yield* withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          assert.strictEqual((yield* store.listThreads({ mailbox: "inbox" })).length, 0);
          assert.strictEqual((yield* store.listThreads({ mailbox: "snoozed" })).length, 1);
          assert.strictEqual((yield* store.organization)[0]?.categories, false);
          assert.strictEqual((yield* store.labelPreferences)[0]?.favorite, true);
          yield* store.moveLabelPreference("gmail:me@example.com", "Work", "Work/Renamed");
          assert.strictEqual((yield* store.labelPreferences)[0]?.id, "Work/Renamed");
          assert.strictEqual((yield* store.labelPreferences)[0]?.visible, false);
          yield* store.moveLabelPreference("gmail:me@example.com", "Work/Renamed", null);
          assert.deepStrictEqual(yield* store.labelPreferences, []);
          assert.strictEqual((yield* store.sendAs)[0]?.address, "alias@example.com");
          assert.strictEqual((yield* store.signatures).length, 2);
          assert.deepStrictEqual(yield* store.wakeSnoozed(10_000), ["gmail:me@example.com/m1"]);
          assert.deepStrictEqual(yield* store.wakeSnoozed(10_000), []);
        }),
        db(),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);
