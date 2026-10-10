import { applyNativeMigration } from "./platform/node/migrations.js";
import { load } from "sqlite-vec";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { DatabaseSync } from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { databaseLayer, MIGRATIONS, splitStatements } from "./platform/node/db.js";
import { DEFAULT_LIST_FILTERS, type Actor, type Command, type IncomingMessage } from "./domain.js";
import { MemoryFileSystem, MemoryPlatform } from "./platform/node/platform-memory.js";
import { AuthError } from "./errors.js";
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
        CATEGORY_PERSONAL: 1,
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
      yield* store.markReauth(
        id,
        new AuthError({ accountId: id, message: "refused", reason: "imap_auth_failed" }),
      );
      yield* store.setSyncError(id, "offline");
      const account = yield* store.getAccount(id);
      assert.deepStrictEqual(account.imap, imap);
      assert.strictEqual(account.needsReauth, true);
      assert.strictEqual(account.reauthReason, "imap_auth_failed");
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
  // Outlook importance changes flags without moving the folder.
  assert.deepStrictEqual(
    applyOpToLabels(["INBOX"], { kind: "important", value: true }, "outlook"),
    ["INBOX", "IMPORTANT"],
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

      yield* store.appendAudit({
        actor: { kind: "agent", surface: "mcp", name: "claude" },
        accountId: account.id,
        action: "archive",
        detail: { id },
      });
      yield* store.appendAudit({
        actor: { kind: "user", surface: "cli" },
        action: "sync",
        detail: undefined,
      });
      const [latest, earlier] = yield* store.listAudit(10);
      assert.ok(latest && earlier);
      assert.strictEqual(latest.actor, "user:cli");
      assert.strictEqual(latest.accountId, null);
      assert.match(JSON.stringify(latest.detail), /"recipientCount":0/);
      assert.strictEqual(earlier.actor, "agent:mcp:claude");
      assert.match(JSON.stringify(earlier.detail), /"hash":"[a-f0-9]{64}"/);
      assert.ok(!JSON.stringify(earlier.detail).includes(`"id":`));
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
    for (const migration of MIGRATIONS) applyNativeMigration(reference, migration);
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
      for (const migration of MIGRATIONS.slice(0, 3)) applyNativeMigration(old, migration);
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
      assert.strictEqual(yield* store.claimPendingOp(op.id, "test-claim"), true);
      // Another process (the CLI next to the app) finds it taken.
      assert.strictEqual(yield* store.claimPendingOp(op.id, "test-claim"), false);
      yield* store.releasePendingOp(op.id, "test-claim");
      assert.strictEqual(yield* store.claimPendingOp(op.id, "test-claim"), true);
      // A claim left by a process that died mid-push runs out after two minutes.
      yield* TestClock.adjust("3 minutes");
      assert.strictEqual(yield* store.claimPendingOp(op.id, "test-claim"), true);
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
        ids(
          yield* store.listThreads({
            mailbox: "drafts",
            listFilters: { ...DEFAULT_LIST_FILTERS, enabled: true },
          }),
        ),
        [`${id}/d1`, "draft:a"],
      );
      assert.deepStrictEqual(
        ids(
          yield* store.listThreads({
            mailbox: "drafts",
            listFilters: { ...DEFAULT_LIST_FILTERS, enabled: false, important: true },
          }),
        ),
        [`${id}/d1`, "draft:a"],
      );
      assert.deepStrictEqual(
        ids(
          yield* store.listThreads({
            mailbox: "drafts",
            listFilters: { ...DEFAULT_LIST_FILTERS, enabled: true, important: true },
          }),
        ),
        [],
      );
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
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-test-" });
      const disk = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
      const db = () => databaseLayer(path.join(dir, "mail.db")).pipe(Layer.provide(disk));
      yield* withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const account = yield* store.upsertAccount("gmail", "me@example.com");
          yield* store.upsertMessage(account.id, message({}));
          yield* store.snooze(`${account.id}/m1`, 10_000);
          yield* store.setOrganization({ accountId: account.id, categories: false });
          yield* store.setPrefs({ showMore: false });
          yield* store.setGrantedScopes(account.id, ["https://mail.google.com/"]);
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
          assert.isFalse((yield* store.prefs).showMore);
          assert.deepStrictEqual(yield* store.grantedScopes("gmail:me@example.com"), [
            "https://mail.google.com/",
          ]);
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

it.effect("initial sync stays silent after a partial checkpoint until the full pull succeeds", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "new@example.com");
      assert.isFalse(yield* store.notificationsReady(account.id));
      yield* store.beginInitialSync(account.id);
      yield* store.saveSyncCursor(account.id, "partial-checkpoint");
      assert.isNotNull((yield* store.getAccount(account.id)).lastSyncedAt);
      assert.isFalse(yield* store.notificationsReady(account.id));
      yield* store.finishInitialSync(account.id);
      assert.isTrue(yield* store.notificationsReady(account.id));
      // Existing accounts upgrade without suppressing future arrivals.
      const existing = yield* store.upsertAccount("outlook", "existing@example.com");
      yield* store.saveSyncCursor(existing.id, "completed-before-upgrade");
      assert.isTrue(yield* store.notificationsReady(existing.id));
    }),
  ),
);

it.effect("incoming bookkeeping does not grow prefs", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "bookkeeping@example.com");
      yield* store.beginInitialSync(account.id);
      yield* store.saveInboxCursor(account.id, "cursor");
      assert.isTrue(yield* store.observeIncoming(account.id, "one"));
      assert.isFalse(yield* store.observeIncoming(account.id, "one"));
      const rows = yield* sql`SELECT COUNT(*) AS n FROM prefs WHERE key LIKE 'system:%'`;
      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))(rows[0]).n,
        0,
      );
    }),
  ),
);
it.effect("removing and re-adding an account drops its incoming cursor and seen identities", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "readd@example.com");
      yield* store.finishInitialSync(account.id);
      yield* store.saveInboxCursor(account.id, "stale");
      yield* store.observeIncoming(account.id, "one");
      yield* store.removeAccount(account.id);
      yield* store.upsertAccount("gmail", "readd@example.com");
      assert.isTrue(Option.isNone(yield* store.getInboxCursor(account.id)));
      assert.isFalse(yield* store.notificationsReady(account.id));
      assert.isTrue(yield* store.observeIncoming(account.id, "one"));
    }),
  ),
);

it.effect("message existence checks do not decode mail payloads", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "existence@example.com");
      yield* store.upsertMessage(account.id, message({}));
      const id = `${account.id}/m1`;
      yield* sql`UPDATE messages SET to_json='invalid legacy JSON' WHERE id=${id}`;
      assert.isTrue(yield* store.hasMessage(id));
      assert.isFalse(yield* store.hasMessage("missing"));
      yield* store.upsertMessage(account.id, message({}));
      assert.deepStrictEqual((yield* store.getMessage(id)).to, []);
    }),
  ),
);

it.effect(
  "migration 10 moves legacy bookkeeping, drops orphan rows, and preserves mail rowids",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "migration.db");
      const db = new DatabaseSync(file);
      try {
        for (const migration of MIGRATIONS.slice(0, 9)) applyNativeMigration(db, migration);
        db.exec("PRAGMA user_version=9");
        const id = "gmail:migration@example.com";
        db.prepare(
          "INSERT INTO accounts(id,provider,email,created_at,last_synced_at) VALUES(?,?,?,?,?)",
        ).run(id, "gmail", "migration@example.com", 0, 1000);
        db.prepare(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
        VALUES(42,?,?, 'one','thread','Legacy','Sender','sender@example.com','[]','[]',1,'','legacyneedle','','["INBOX"]','[]',1,0)`).run(
          `${id}/one`,
          id,
        );
        const insert = db.prepare("INSERT INTO prefs(key,value_json) VALUES(?,?)");
        insert.run(`system:seen:${JSON.stringify([id, 'identity with "quotes"'])}`, "true");
        insert.run(`system:seen:${JSON.stringify(["gone", "orphan"])}`, "true");
        insert.run("system:seen:malformed", "true");
        insert.run(`system:inbox:${id}`, "opaque-cursor");
        insert.run(`system:initial:${id}`, "false");
        insert.run("language", '"en"');
      } finally {
        db.close();
      }
      yield* withStore(
        Effect.gen(function* () {
          const store = yield* Store;
          const sql = yield* SqlClient.SqlClient;
          const id = "gmail:migration@example.com";
          assert.strictEqual(Option.getOrNull(yield* store.getInboxCursor(id)), "opaque-cursor");
          assert.isFalse(yield* store.notificationsReady(id));
          assert.isFalse(yield* store.observeIncoming(id, 'identity with "quotes"'));
          assert.strictEqual((yield* store.prefs).language, "en");
          const rows = yield* sql`SELECT COUNT(*) AS n FROM seen_incoming`;
          assert.strictEqual(
            Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))(rows[0]).n,
            1,
          );
          const mailRows = yield* sql`SELECT rowid FROM messages WHERE id=${`${id}/one`}`;
          assert.strictEqual(
            Schema.decodeUnknownSync(Schema.Struct({ rowid: Schema.Number }))(mailRows[0]).rowid,
            42,
          );
          assert.strictEqual((yield* store.listThreads({ search: "legacyneedle" })).length, 1);
          const old = yield* sql`SELECT COUNT(*) AS n FROM prefs WHERE key LIKE 'system:%'`;
          assert.strictEqual(
            Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))(old[0]).n,
            0,
          );
        }),
        databaseLayer(file).pipe(
          Layer.provide(NodeFileSystem.layer),
          Layer.provide(NodePath.layer),
        ),
      );
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);

it.effect("Reply-To updates retain rowids and FTS, and absent headers clear cached targets", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const id = `${account.id}/m1`;
      yield* store.upsertMessage(account.id, message({}));
      const before = yield* sql`SELECT rowid FROM messages WHERE id=${id}`;
      assert.deepStrictEqual((yield* store.getMessage(id)).replyTo, []);
      const replyTo = [{ name: "Reply, Team", address: "reply@example.com" }];
      yield* store.upsertMessage(account.id, message({ replyTo }));
      assert.deepStrictEqual((yield* store.getMessage(id)).replyTo, replyTo);
      assert.deepStrictEqual((yield* store.getThread(id))[0]?.replyTo, replyTo);
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${id}`, before);
      assert.strictEqual((yield* store.listThreads({ search: "产能数据" })).length, 1);
      yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`;
      yield* store.upsertMessage(account.id, message({}));
      assert.deepStrictEqual((yield* store.getMessage(id)).replyTo, []);
    }),
  ),
);

it.effect("full recipient display preference defaults off and survives unrelated writes", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      assert.isFalse((yield* store.prefs).showFullRecipientAddresses);
      yield* store.setPrefs({ showFullRecipientAddresses: true });
      yield* store.setPrefs({ undoSendSeconds: 20 });
      assert.isTrue((yield* store.prefs).showFullRecipientAddresses);
      yield* store.setPrefs({ showFullRecipientAddresses: false });
      assert.isFalse((yield* store.prefs).showFullRecipientAddresses);
      yield* sql`UPDATE prefs SET value_json='"invalid"' WHERE key='showFullRecipientAddresses'`;
      assert.isFalse((yield* store.prefs).showFullRecipientAddresses);
    }),
  ),
);

it.effect(
  "migration 14 preserves v13 mail and rowids, then persists Reply-To and display preference",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openmail-reply-to-" });
      const file = path.join(dir, "mail.db");
      const accountId = "gmail:me@example.com";
      const messageId = `${accountId}/m1`;
      const replyTo = [{ name: "Reply", address: "reply@example.com" }];
      yield* Effect.sync(() => {
        const old = new DatabaseSync(file);
        try {
          for (const migration of MIGRATIONS.slice(0, 13)) applyNativeMigration(old, migration);
          old.exec("PRAGMA user_version=13");
          old
            .prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)")
            .run(accountId, "gmail", "me@example.com", 0);
          old
            .prepare(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,
          from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,
          attachments_json,is_unread,is_starred) VALUES(42,?,?, 'm1','t1','Legacy','Sender',
          'sender@example.com','[]','[]',1,'','legacyneedle','','["INBOX"]','[]',1,0)`)
            .run(messageId, accountId);
        } finally {
          old.close();
        }
      });
      for (const reopening of [false, true]) {
        yield* withStore(
          Effect.gen(function* () {
            const store = yield* Store;
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              (yield* store.getMessage(messageId)).replyTo,
              reopening ? replyTo : undefined,
            );
            assert.strictEqual((yield* store.prefs).showFullRecipientAddresses, reopening);
            const [row] = yield* sql`SELECT rowid FROM messages WHERE id=${messageId}`;
            assert.strictEqual(Schema.decodeUnknownSync(Row)(row).rowid, 42);
            assert.strictEqual((yield* store.listThreads({ search: "legacyneedle" })).length, 1);
            if (!reopening) {
              yield* store.upsertMessage(accountId, message({ replyTo, bodyText: "legacyneedle" }));
              yield* store.setPrefs({ showFullRecipientAddresses: true });
            }
            yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')`;
          }),
          databaseLayer(file).pipe(
            Layer.provide(NodeFileSystem.layer),
            Layer.provide(NodePath.layer),
          ),
        );
      }
    }).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);

it.effect("stores provider authentication without changing the FTS row identity", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const { id } = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.upsertMessage(
        id,
        message({ from: { name: "Ali\u202ece", address: "alice@example.com" } }),
      );
      const messageId = `${id}/m1`;
      const before = yield* sql`SELECT rowid FROM messages WHERE id=${messageId}`;
      const security = { dmarc: "fail", spf: "pass", dkim: "fail" } as const;
      const headers = [{ name: "List-Id", value: "Orders <orders.example.com>" }];
      yield* store.upsertMessage(id, message({ security, headers }));
      assert.deepStrictEqual((yield* store.getMessage(messageId)).headers, headers);
      assert.deepStrictEqual((yield* store.getMessage(messageId)).security, security);
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${messageId}`, before);
      yield* store.upsertMessage(id, message({}));
      assert.deepStrictEqual((yield* store.getMessage(messageId)).security, security);
      const pass = { dmarc: "pass", spf: "pass", dkim: "pass" } as const;
      yield* store.upsertMessage(id, message({ security: pass }));
      assert.deepStrictEqual((yield* store.getMessage(messageId)).security, pass);
      assert.deepStrictEqual((yield* store.getMessage(messageId)).headers, headers);
      const changedHeaders = [{ name: "List-Id", value: "Updates <updates.example.com>" }];
      yield* store.upsertMessage(id, message({ headers: changedHeaders }));
      assert.deepStrictEqual((yield* store.getMessage(messageId)).headers, changedHeaders);
      assert.deepStrictEqual((yield* store.getMessage(messageId)).security, pass);
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${messageId}`, before);
    }),
  ),
);

it.effect("provider remaps preserve local rowids, derived data, snoozes and queued ops", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", rfcMessageId: "<one@x>" }),
      );
      const local = `${account.id}/7:1:INBOX`;
      yield* store.snooze(local, 999999);
      yield* store.enqueueOp(account.id, "7:1:INBOX", { kind: "star", value: true });
      yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES (${local},'cached OCR','{}')`;
      const before = yield* sql`SELECT rowid FROM messages WHERE id=${local}`;
      yield* store.remapProviderIds(account.id, [{ from: "7:1:INBOX", to: "8:9:INBOX" }]);
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "8:9:INBOX", rfcMessageId: "<one@x>" }),
      );
      yield* store.deleteMessage(account.id, "7:1:INBOX");
      assert.strictEqual((yield* store.messageRef(local)).providerId, "8:9:INBOX");
      assert.deepStrictEqual(yield* sql`SELECT rowid FROM messages WHERE id=${local}`, before);
      assert.strictEqual((yield* store.listPendingOps)[0]?.providerId, "8:9:INBOX");
      assert.strictEqual(
        (yield* sql`SELECT text FROM derived_chunks WHERE message_id=${local}`)[0]?.text,
        "cached OCR",
      );
      assert.ok((yield* store.getMessage(local)).labels.includes("SNOOZED"));
      assert.strictEqual(
        (yield* sql`SELECT provider_id FROM snoozed_messages`)[0]?.provider_id,
        "8:9:INBOX",
      );
      assert.strictEqual((yield* store.listThreads({ search: "产能" }))[0]?.id, local);
    }),
  ),
);

it.effect("replies without References inherit a parent's thread via Message-ID", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "parent", threadId: "root@x", rfcMessageId: "<parent@x>" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({
          providerId: "child",
          threadId: "child@x",
          parentRfcMessageId: "<parent@x>",
          rfcMessageId: "<child@x>",
        }),
      );
      assert.strictEqual((yield* store.getMessage(`${account.id}/child`)).threadId, "root@x");
      yield* store.upsertMessage(
        account.id,
        message({
          providerId: "unrelated",
          threadId: "unrelated@x",
          parentRfcMessageId: "<missing@x>",
        }),
      );
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/unrelated`)).threadId,
        "unrelated@x",
      );
    }),
  ),
);

it.effect("expired-history window sweeping preserves older cached mail", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      for (const providerId of ["kept", "gone", "old"])
        yield* store.upsertMessage(
          account.id,
          message({ providerId, date: providerId === "old" ? 1 : 100 }),
        );
      yield* store.deleteAccountMessages(account.id, ["kept"], 50);
      assert.deepStrictEqual(
        (yield* store.listThreads({ flat: true }))
          .map((m) => m.id.split("/").at(-1))
          .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
        ["kept", "old"],
      );
    }),
  ),
);

it.effect("SQLite limits journal size and permits an idle truncate checkpoint", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      assert.strictEqual((yield* sql`PRAGMA journal_size_limit`)[0]?.journal_size_limit, 8388608);
      yield* store.checkpoint;
    }),
  ),
);

it.effect("remapping a duplicate target preserves source identity and snooze", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", threadId: "source", rfcMessageId: "<same@x>" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "8:2:INBOX", threadId: "target", rfcMessageId: "<same@x>" }),
      );
      const source = `${account.id}/7:1:INBOX`,
        target = `${account.id}/8:2:INBOX`;
      yield* store.snooze(source, 10000);
      yield* store.snooze(target, 10000);
      yield* sql`INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES (${target},'duplicate OCR','{}')`;
      yield* store.remapProviderIds(account.id, [{ from: "7:1:INBOX", to: "8:2:INBOX" }]);
      assert.strictEqual(yield* store.messageIdForProvider(account.id, "8:2:INBOX"), source);
      assert.strictEqual((yield* sql`SELECT id FROM messages`).length, 1);
      assert.strictEqual((yield* sql`SELECT provider_id FROM snoozed_messages`).length, 1);
      assert.strictEqual((yield* sql`SELECT text FROM derived_chunks`).length, 0);
    }),
  ),
);

it.effect("re-upsert retains an inherited thread when the parent is unavailable", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(account.id, message({ threadId: "root@x" }));
      yield* store.upsertMessage(
        account.id,
        message({ threadId: "parent@x", parentRfcMessageId: "<parent@x>" }),
      );
      assert.strictEqual((yield* store.getMessage(`${account.id}/m1`)).threadId, "root@x");
    }),
  ),
);

it.effect("folder-prefix lookup includes untracked backfilled rows", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "6:99:INBOX", rfcMessageId: "<backfilled@x>" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "6:2:Sent", rfcMessageId: "<backfilled@x>" }),
      );
      assert.strictEqual(
        yield* store.findMessageByRfcId(account.id, "backfilled@x", {
          path: "INBOX",
          uidValidity: "6",
        }),
        `${account.id}/6:99:INBOX`,
      );
      yield* store.deleteImapFolder(account.id, { path: "INBOX", uidValidity: "6" }, []);
      assert.strictEqual(yield* store.messageIdForProvider(account.id, "6:99:INBOX"), null);
      assert.strictEqual(
        yield* store.messageIdForProvider(account.id, "6:2:Sent"),
        `${account.id}/6:2:Sent`,
      );
    }),
  ),
);

it.effect("routine checkpoints retain the reusable WAL instead of truncating it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "openmail-checkpoint-" }),
      (dir) => fs.remove(dir, { recursive: true }).pipe(Effect.orDie),
    );
    const file = path.join(dir, "mail.db");
    yield* withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("gmail", "me@example.com");
        yield* store.upsertMessage(account.id, message({}));
        yield* store.checkpoint;
        assert.isAbove(Number((yield* fs.stat(`${file}-wal`)).size), 0);
      }),
      databaseLayer(file).pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer)),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);

it.effect("database failures during remap propagate and roll back", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(account.id, message({ providerId: "old" }));
      yield* sql`CREATE TRIGGER reject_remap BEFORE UPDATE OF provider_id ON messages BEGIN SELECT RAISE(ABORT,'simulated remap failure'); END`;
      const result = yield* store
        .remapProviderIds(account.id, [{ from: "old", to: "new" }])
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual((yield* store.messageRef(`${account.id}/old`)).providerId, "old");
    }),
  ),
);

it.effect("remapping never deletes an unrelated target", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:2:INBOX", rfcMessageId: "<x@x>" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "8:5:INBOX", rfcMessageId: "<y@x>" }),
      );
      yield* store.enqueueOp(account.id, "8:5:INBOX", { kind: "star", value: true });
      yield* store.remapProviderIds(account.id, [{ from: "7:2:INBOX", to: "8:5:INBOX" }]);
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/8:5:INBOX`)).rfcMessageId,
        "<y@x>",
      );
      assert.strictEqual((yield* store.listPendingOps)[0]?.op.kind, "reconcile");
      assert.notStrictEqual((yield* store.listPendingOps)[0]?.providerId, "8:5:INBOX");
    }),
  ),
);

it.effect("an upsert cannot overwrite a local id left behind by a move", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:2:INBOX", rfcMessageId: "<x@x>" }),
      );
      yield* store.remapProviderIds(account.id, [{ from: "7:2:INBOX", to: "8:5:Archive" }]);
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:2:INBOX", rfcMessageId: "<y@x>" }),
      );
      assert.strictEqual(
        (yield* store.getMessage(`${account.id}/7:2:INBOX`)).rfcMessageId,
        "<x@x>",
      );
      const fresh = yield* store.messageIdForProvider(account.id, "7:2:INBOX");
      assert.ok(fresh);
      assert.notStrictEqual(fresh, `${account.id}/7:2:INBOX`);
      assert.strictEqual((yield* store.getMessage(fresh)).rfcMessageId, "<y@x>");
    }),
  ),
);

it.effect("IMAP folder matching uses the complete path after the UID", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "6:99:Parent:INBOX", rfcMessageId: "<one@x>" }),
      );
      assert.strictEqual(
        yield* store.findMessageByRfcId(account.id, "<one@x>", { path: "INBOX", uidValidity: "6" }),
        null,
      );
      yield* store.deleteImapFolder(account.id, { path: "INBOX", uidValidity: "6" }, []);
      assert.ok(yield* store.messageIdForProvider(account.id, "6:99:Parent:INBOX"));
    }),
  ),
);

it.effect("invalidated local ids are never reused and stale local work is discarded", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      const old = `${account.id}/7:1:INBOX`;
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", rfcMessageId: "<x@x>" }),
      );
      yield* store.snooze(old, 999999);
      yield* store.enqueueOp(account.id, "7:1:INBOX", {
        kind: "deleteDraft",
        remote: { draftId: "7:1:INBOX", messageId: "7:1:INBOX" },
      });
      yield* store.invalidateImapFolder(account.id, { path: "INBOX", uidValidity: "7" });
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", rfcMessageId: "<y@x>" }),
      );
      const fresh = yield* store.messageIdForProvider(account.id, "7:1:INBOX");
      assert.notStrictEqual(fresh, old);
      assert.isTrue((yield* store.messageRef(old)).providerId.startsWith("unmapped:"));
      assert.strictEqual((yield* sql`SELECT * FROM thread_reminders`).length, 0);
      assert.isTrue(
        (yield* store.listPendingOps).every(
          (op) => op.op.kind === "reconcile" && op.providerId.startsWith("unmapped:"),
        ),
      );
      // A second invalidation creates a new generation, even when the UID and Message-ID recur.
      yield* store.invalidateImapFolder(account.id, { path: "INBOX", uidValidity: "7" });
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", rfcMessageId: "<y@x>" }),
      );
      assert.notStrictEqual(yield* store.messageIdForProvider(account.id, "7:1:INBOX"), fresh);
    }),
  ),
);

it.effect("an unrelated remap target always has a cleanup reconciliation", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "7:1:INBOX", rfcMessageId: "<x@x>" }),
      );
      yield* store.upsertMessage(
        account.id,
        message({ providerId: "8:2:Archive", rfcMessageId: "<y@x>" }),
      );
      yield* store.remapProviderIds(account.id, [{ from: "7:1:INBOX", to: "8:2:Archive" }]);
      const detached = (yield* store.messageRef(`${account.id}/8:2:Archive`)).providerId;
      assert.ok(
        (yield* store.listPendingOps).some(
          (op) => op.providerId === detached && op.op.kind === "reconcile",
        ),
      );
    }),
  ),
);

it.effect("folder epochs survive reopening the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ prefix: "openmail-epoch-" }),
      (dir) => fs.remove(dir, { recursive: true }).pipe(Effect.orDie),
    );
    const file = path.join(dir, "mail.db");
    const platform = () =>
      databaseLayer(file).pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(NodePath.layer));
    const before = yield* withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.upsertMessage(
          account.id,
          message({ providerId: "7:1:INBOX", rfcMessageId: "<x@x>" }),
        );
        yield* store.invalidateImapFolder(account.id, { path: "INBOX", uidValidity: "7" });
        yield* store.upsertMessage(
          account.id,
          message({ providerId: "7:1:INBOX", rfcMessageId: "<y@x>" }),
        );
        return {
          accountId: account.id,
          local: yield* store.messageIdForProvider(account.id, "7:1:INBOX"),
        };
      }),
      platform(),
    );
    yield* withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        assert.isTrue(
          (yield* store.messageRef(`${before.accountId}/7:1:INBOX`)).providerId.startsWith(
            "unmapped:",
          ),
        );
        assert.strictEqual(
          yield* store.messageIdForProvider(before.accountId, "7:1:INBOX"),
          before.local,
        );
        yield* store.invalidateImapFolder(before.accountId, { path: "INBOX", uidValidity: "7" });
        yield* store.upsertMessage(
          before.accountId,
          message({ providerId: "7:1:INBOX", rfcMessageId: "<y@x>" }),
        );
        assert.notStrictEqual(
          yield* store.messageIdForProvider(before.accountId, "7:1:INBOX"),
          before.local,
        );
      }),
      platform(),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer)),
);

it.effect("coalescing a waiting draft save preserves its APPEND identity and copy progress", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      const message = {
        to: [],
        cc: [],
        bcc: [],
        subject: "draft",
        text: "original",
        attachments: [],
      };
      yield* store.putDraft({ id: "draft:carry", accountId: account.id, message });
      yield* store.enqueueDraftSave(account.id, "draft:carry");
      const [first] = yield* store.listPendingOps;
      assert.ok(first);
      assert.isTrue(yield* store.claimPendingOp(first.id, "writer"));
      yield* store.recordAppendedMessageId(first.id, "writer", "<appended@example.com>");
      yield* store.recordCopyProgress(first.id, "writer", "Drafts", "draft:carry", "accepted");
      yield* store.failPendingOp(first.id, "Lost APPEND acknowledgement", "writer");
      yield* store.putDraft({
        id: "draft:carry",
        accountId: account.id,
        message: { ...message, text: "edited" },
      });
      yield* store.enqueueDraftSave(account.id, "draft:carry");
      const [replacement] = yield* store.listPendingOps;
      assert.ok(replacement);
      assert.notStrictEqual(replacement.id, first.id);
      assert.strictEqual(replacement.appendedMessageId, "<appended@example.com>");
      assert.strictEqual(replacement.progress.length, 2);
    }),
  ),
);

for (const action of ["discard", "local"] as const)
  it.effect(`${action} queues cleanup of an unacknowledged appended draft`, () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.putDraft({
          id: "draft:cleanup",
          accountId: account.id,
          message: { to: [], cc: [], bcc: [], subject: "draft", text: "content", attachments: [] },
        });
        yield* store.enqueueDraftSave(account.id, "draft:cleanup");
        const [op] = yield* store.listPendingOps;
        assert.ok(op);
        yield* store.claimPendingOp(op.id, "writer");
        yield* store.recordAppendedMessageId(op.id, "writer", "<orphan@example.com>");
        yield* store.failPendingOp(op.id, "Lost APPEND acknowledgement", "writer");
        yield* action === "discard"
          ? store.deleteDraft("draft:cleanup")
          : store.setDraftLocalOnly("draft:cleanup", true);
        const queued = yield* store.listPendingOps;
        assert.strictEqual(queued.length, 1);
        assert.ok(queued[0]?.op.kind === "deleteDraft");
        assert.ok("rfcMessageId" in queued[0].op.remote);
        assert.strictEqual(queued[0].op.remote.rfcMessageId, "<orphan@example.com>");
      }),
    ),
  );

it.effect("retry keeps APPEND progress until the next save is coalesced", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const account = yield* store.upsertAccount("imap", "me@example.com");
      yield* store.putDraft({
        id: "draft:retry",
        accountId: account.id,
        message: { to: [], cc: [], bcc: [], subject: "draft", text: "content", attachments: [] },
      });
      yield* store.enqueueDraftSave(account.id, "draft:retry");
      const [op] = yield* store.listPendingOps;
      assert.ok(op);
      yield* store.claimPendingOp(op.id, "writer");
      yield* store.recordAppendedMessageId(op.id, "writer", "<retry@example.com>");
      yield* store.failPendingOp(op.id, "Lost APPEND acknowledgement", "writer");
      yield* store.setDraftLocalOnly("draft:retry", false);
      yield* store.enqueueDraftSave(account.id, "draft:retry");
      assert.strictEqual(
        (yield* store.listPendingOps)[0]?.appendedMessageId,
        "<retry@example.com>",
      );
    }),
  ),
);

it.effect("switching accounts cleans the original APPEND identity without reusing it", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const original = yield* store.upsertAccount("imap", "original@example.com");
      const next = yield* store.upsertAccount("imap", "next@example.com");
      const message = {
        to: [],
        cc: [],
        bcc: [],
        subject: "draft",
        text: "content",
        attachments: [],
      };
      yield* store.putDraft({ id: "draft:moved", accountId: original.id, message });
      yield* store.enqueueDraftSave(original.id, "draft:moved");
      const [op] = yield* store.listPendingOps;
      assert.ok(op);
      yield* store.claimPendingOp(op.id, "writer");
      yield* store.recordAppendedMessageId(op.id, "writer", "<original@example.com>");
      yield* store.failPendingOp(op.id, "Lost APPEND acknowledgement", "writer");
      yield* store.putDraft({ id: "draft:moved", accountId: next.id, message });
      yield* store.enqueueDraftSave(next.id, "draft:moved");
      const queued = yield* store.listPendingOps;
      const cleanup = queued.find((p) => p.accountId === original.id);
      const save = queued.find((p) => p.accountId === next.id);
      assert.ok(cleanup?.op.kind === "deleteDraft");
      assert.strictEqual(cleanup.op.remote.rfcMessageId, "<original@example.com>");
      assert.strictEqual(save?.appendedMessageId, null);
      assert.deepStrictEqual(save?.progress, []);
    }),
  ),
);

it.effect("audit keeps only metadata and decisions purge proposal commands and rationale", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* Store;
      const sql = yield* SqlClient.SqlClient;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      const actor: Actor = {
        kind: "agent",
        surface: "mcp",
        name: "client",
        rationale: "SECRET_REASON",
      };
      const command: Command = {
        kind: "draft",
        accountId: account.id,
        message: {
          to: [{ name: "SECRET_NAME", address: "secret@example.com" }],
          cc: [],
          bcc: [],
          subject: "SECRET_SUBJECT",
          text: "SECRET_BODY",
          attachments: [],
        },
      };
      const id = yield* store.insertProposal(actor, command);
      yield* store.appendAudit({ actor, action: "proposed", detail: { command } });
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ detail_json: Schema.String })),
      )(yield* sql`SELECT detail_json FROM audit_log`);
      const raw = rows[0]?.detail_json ?? "";
      assert.ok(!/SECRET|secret@example.com/.test(raw));
      assert.deepStrictEqual(
        Object.keys(
          Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(raw),
        ).toSorted(),
        ["accountId", "hash", "kind", "recipientCount"],
      );
      assert.include(raw, '"recipientCount":1');
      yield* store.setProposalStatus(id, "approved");
      const decided = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ command_json: Schema.String, actor_json: Schema.String })),
      )(yield* sql`SELECT command_json,actor_json FROM proposals WHERE id=${id}`);
      assert.strictEqual(decided[0]?.command_json, "{}");
      assert.ok(!decided[0]?.actor_json.includes("SECRET_REASON"));
    }),
  ),
);

it.effect(
  "removing an account rejects its pending thread and draft proposals and purges their payloads",
  () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* Store;
        const sql = yield* SqlClient.SqlClient;
        const account = yield* store.upsertAccount("gmail", "remove@example.com");
        const other = yield* store.upsertAccount("gmail", "keep@example.com");
        yield* store.upsertMessage(account.id, message({}));
        const actor: Actor = {
          kind: "agent",
          surface: "mcp",
          name: "client",
          rationale: "PRIVATE_REASON",
        };
        yield* store.insertProposal(actor, {
          kind: "modify",
          threads: [`${account.id}/m1`],
          op: { kind: "archive" },
        });
        const draftCommand: Command = {
          kind: "draft",
          accountId: account.id,
          message: {
            to: [],
            cc: [],
            bcc: [],
            subject: "PRIVATE_SUBJECT",
            text: "PRIVATE_BODY",
            attachments: [],
          },
        };
        const draftId = yield* store.insertProposal(actor, draftCommand);
        yield* store.putDraft({
          id: "purge-draft",
          accountId: account.id,
          message: draftCommand.message,
          proposalId: draftId,
        });
        const keep = yield* store.insertProposal(actor, { ...draftCommand, accountId: other.id });
        yield* store.removeAccount(account.id);
        assert.deepStrictEqual(
          (yield* store.listProposals("pending")).map((p) => p.id),
          [keep],
        );
        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(
            Schema.Struct({
              status: Schema.String,
              command_json: Schema.String,
              actor_json: Schema.String,
            }),
          ),
        )(yield* sql`SELECT status,command_json,actor_json FROM proposals WHERE id!=${keep}`);
        assert.strictEqual(rows.length, 2);
        for (const row of rows) {
          assert.strictEqual(row.status, "rejected");
          assert.strictEqual(row.command_json, "{}");
          assert.ok(!row.actor_json.includes("PRIVATE_REASON"));
        }
        assert.isTrue(Option.isNone(yield* store.getDraft("purge-draft")));
      }),
    ),
);

it.effect("opening an existing database scrubs legacy audit and decided proposal payloads", () =>
  withStore(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM prefs WHERE key='security:ai-retention-v1'`;
      const actor = JSON.stringify({
        kind: "agent",
        surface: "mcp",
        name: "old-client",
        rationale: "LEGACY_REASON",
      });
      const command = JSON.stringify({
        kind: "draft",
        accountId: "a",
        message: {
          to: [],
          cc: [],
          bcc: [],
          subject: "LEGACY_SUBJECT",
          text: "LEGACY_BODY",
          attachments: [],
        },
      });
      yield* sql`INSERT INTO proposals(created_at,actor_json,command_json,status,decided_at) VALUES(1,${actor},${command},'approved',2)`;
      yield* sql`INSERT INTO audit_log(at,actor,action,detail_json) VALUES(1,'agent:mcp:old-client','proposed',${JSON.stringify({ command: { kind: "draft", accountId: "a", message: { to: [], cc: [], bcc: [], subject: "LEGACY_SUBJECT", text: "LEGACY_BODY", attachments: [] } } })})`;
      yield* Store.pipe(Effect.provide(Layer.fresh(StoreLive)));
      const proposals = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ command_json: Schema.String, actor_json: Schema.String })),
      )(yield* sql`SELECT command_json,actor_json FROM proposals`);
      assert.strictEqual(proposals[0]?.command_json, "{}");
      assert.ok(!proposals[0]?.actor_json.includes("LEGACY_REASON"));
      const audit = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ detail_json: Schema.String })),
      )(yield* sql`SELECT detail_json FROM audit_log`);
      assert.ok(!audit[0]?.detail_json.includes("LEGACY_"));
      assert.match(audit[0]?.detail_json ?? "", /"hash":"[a-f0-9]{64}"/);
      // A later startup does not scan or rewrite the audit table again.
      yield* sql`INSERT INTO audit_log(at,actor,action,detail_json) VALUES(3,'user:app','probe','{"afterMarker":true}')`;
      yield* Store.pipe(Effect.provide(Layer.fresh(StoreLive)));
      assert.deepStrictEqual(yield* sql`SELECT detail_json FROM audit_log WHERE at=3`, [
        { detail_json: '{"afterMarker":true}' },
      ]);
    }),
  ),
);
