import { applyNativeMigration } from "./platform/node/migrations.js";
import { RECOVERY_TABLES } from "./platform/node/database-recovery.js";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer, Stream, Fiber, Schema } from "effect";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkLocalDatabase,
  createLocalDiagnostics,
  CRASH_WINDOW_MS,
  resetLocalCache,
} from "./platform/node/diagnostics.js";
import { Mailbox } from "./mailbox.js";
import { MailboxLive } from "./mailbox-live.js";
import { fakeServer } from "./platform/node/testing.js";
import { makeFakeProvider } from "./platform/node/fake-provider.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { Providers } from "./services.js";
import { StoreLive } from "./store.js";

const directories: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "openmail-reliability-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("excludes message content, addresses, headers, tokens and error text, including tampered records", () => {
  const dir = temp();
  const log = createLocalDiagnostics(dir);
  const privateData = {
    account: "alice.smith+private@personal.example",
    subject: "Acquisition plan $23m",
    body: "The confidential message body",
    html: "<p>Secret html body</p>",
    token: "ya29.SuperSecretAccessToken",
    refreshToken: "1//SuperSecretRefreshToken",
    attachments: [{ content: "cHJpdmF0ZS1hdHRhY2htZW50", filename: "confidential.pdf" }],
    cause: new Error("Bearer secret@example.com with password=supersecret"),
    code: 137,
  };
  log.record("runtime-error", privateData);
  const contents = readFileSync(log.file, "utf8");
  expect(contents).toContain('"accountHash"');
  expect(contents).toContain('"code":137');
  writeFileSync(
    `${log.file}.1`,
    `${JSON.stringify({ event: privateData.body, ...privateData })}\n${JSON.stringify({ event: "startup", at: 1, ...privateData })}`,
  );
  const preview = log.preview();
  for (const text of [
    privateData.account,
    privateData.subject,
    privateData.body,
    privateData.html,
    privateData.token,
    privateData.refreshToken,
    privateData.attachments[0]?.content,
    privateData.attachments[0]?.filename,
    privateData.cause.message,
  ]) {
    expect(contents).not.toContain(text);
    expect(preview).not.toContain(text);
  }
  expect(preview).not.toContain("subject");
  expect(preview).not.toContain("attachments");
});

it("caps every log and keeps only the configured number of rotated files", () => {
  const dir = temp();
  const log = createLocalDiagnostics(dir, { maxBytes: 512, archives: 2 });
  for (let i = 0; i < 120; i++) log.record("renderer-crash", { code: i });
  expect(readdirSync(dir).toSorted()).toEqual([
    "diagnostics.jsonl",
    "diagnostics.jsonl.1",
    "diagnostics.jsonl.2",
  ]);
  for (const file of readdirSync(dir))
    expect(readFileSync(join(dir, file)).length).toBeLessThanOrEqual(512);
  expect(log.preview(true)).toBe("");
});

it("enters safe mode after three abnormal exits in five minutes and preserves consent across clean restarts", () => {
  const dir = temp();
  let at = 100;
  const open = () => createLocalDiagnostics(dir, { now: () => at });
  expect(open().begin()).toEqual({ safeMode: false, crashed: false, abnormalExit: false });
  at += 10;
  expect(open().begin()).toEqual({ safeMode: false, crashed: true, abnormalExit: true });
  at += 10;
  expect(open().begin().safeMode).toBe(false);
  at += 10;
  const fourth = open();
  expect(fourth.begin().safeMode).toBe(true);
  fourth.finish();
  at += CRASH_WINDOW_MS + 1;
  const later = open();
  expect(later.begin()).toEqual({ safeMode: false, crashed: true, abnormalExit: false });
  expect(later.preview(true)).toContain("abnormal-exit");
  later.acknowledge();
  later.finish();
  expect(open().begin().crashed).toBe(false);
});

it("counts renderer crashes globally and prunes only the detection window", () => {
  const log = createLocalDiagnostics(temp(), { now: () => 100 });
  log.begin();
  expect(log.crash("renderer-crash", 139)).toBe(false);
  expect(log.crash("renderer-crash", 137)).toBe(false);
  expect(log.crash("renderer-crash", 139)).toBe(true);
  expect(log.preview(true).split("\n")).toHaveLength(3);
});

it("replaces an unreadable database with a verified migrated file and keeps the original", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  writeFileSync(file, "damaged private database");
  expect(checkLocalDatabase(dir)).not.toBe("ok");
  const result = resetLocalCache(dir);
  expect(result).toMatchObject({ kind: "recovered" });
  expect(checkLocalDatabase(dir)).toBe("ok");
  const backup = readdirSync(dir).find((name) => name.startsWith("mail.db.corrupt-"));
  expect(backup).toBeDefined();
  expect(readFileSync(join(dir, backup ?? "missing"), "utf8")).toBe("damaged private database");
  const db = new DatabaseSync(file);
  try {
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(MIGRATIONS.length);
  } finally {
    db.close();
  }
});

it("resets a real cache then re-syncs through a fake provider while accounts and shared drafts survive", async () => {
  const dir = temp();
  const server = fakeServer("owner@example.com", [
    {
      providerId: "m1",
      threadId: "t1",
      subject: "Cached subject",
      from: { name: "Alice", address: "alice@example.com" },
      to: [],
      cc: [],
      date: 1,
      snippet: "body",
      bodyText: "body",
      bodyHtml: "",
      attachments: [],
      labels: ["INBOX"],
      isUnread: true,
      isStarred: false,
    },
  ]);
  const layer = () =>
    MailboxLive({ backgroundFlush: false }).pipe(
      Layer.provide(
        Layer.merge(
          StoreLive.pipe(
            Layer.provide(databaseLayer(join(dir, "mail.db")).pipe(Layer.provide(NodeSystem))),
          ),
          Layer.succeed(Providers, Providers.of({ get: () => makeFakeProvider(server) })),
        ),
      ),
      Layer.provide(MemoryPlatform()),
    );
  let accountId = "";
  await Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Mailbox;
      const account = yield* m.connect({ provider: "gmail" });
      accountId = account.id;
      yield* m.sync();
      expect(yield* m.threads({})).toHaveLength(1);
      yield* m.setPrefs({ undoSendSeconds: 10 });
      yield* m.saveDraft({
        id: "shared-draft",
        accountId,
        message: {
          to: [{ name: "", address: "recipient@example.com" }],
          cc: [],
          bcc: [],
          subject: "Feedback draft",
          text: "User feedback",
          attachments: [],
        },
      });
    }).pipe(Effect.provide(layer())),
  );
  expect(checkLocalDatabase(dir)).toBe("ok");
  const brokenIndex = new DatabaseSync(join(dir, "mail.db"));
  brokenIndex.exec("INSERT INTO messages_fts(messages_fts) VALUES ('delete-all')");
  brokenIndex.close();
  resetLocalCache(dir);
  const repairedIndex = new DatabaseSync(join(dir, "mail.db"));
  expect(() =>
    repairedIndex.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES ('integrity-check',1)"),
  ).not.toThrow();
  repairedIndex.close();
  expect(checkLocalDatabase(dir)).toBe("ok");
  await Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* Mailbox;
      expect((yield* m.accounts).map((a) => a.id)).toEqual([accountId]);
      expect((yield* m.prefs).undoSendSeconds).toBe(10);
      expect((yield* m.openDraft("shared-draft")).message.text).toBe("User feedback");
      expect(yield* m.threads({})).toHaveLength(0);
      yield* m.sync();
      expect(yield* m.threads({})).toHaveLength(1);
      const draft = yield* m.openDraft("shared-draft");
      yield* m.saveDraft({
        id: draft.id,
        accountId,
        message: { ...draft.message, text: "Edited in another window" },
      });
      expect((yield* m.openDraft("shared-draft")).message.text).toBe("Edited in another window");
      expect(server.sent).toHaveLength(0);
      const saves = server.draftLog.length;
      const feedback = {
        to: [{ name: "", address: "feedback@example.com" }],
        cc: [],
        bcc: [],
        subject: "Feedback",
        text: "User review",
        attachments: [
          {
            filename: "diagnostics.jsonl",
            mimeType: "application/x-ndjson",
            content: "cmVkYWN0ZWQ=",
          },
        ],
      };
      const change = yield* m.events.pipe(
        Stream.filter((event) => event._tag === "Changed"),
        Stream.take(1),
        Stream.runCollect,
        // Subscribe synchronously before saveDraft can publish Changed.
        Effect.forkChild({ startImmediately: true }),
      );
      yield* m.saveDraft({ id: "feedback:local", accountId, message: feedback });
      expect(yield* Fiber.join(change)).toHaveLength(1);
      yield* m.saveDraft({
        id: "feedback:local",
        accountId,
        message: { ...feedback, text: "Reviewed locally" },
      });
      expect((yield* m.openDraft("feedback:local")).message.text).toBe("Reviewed locally");
      expect(server.draftLog).toHaveLength(saves);
      expect(server.sent).toHaveLength(0);
      yield* m.perform(
        { kind: "send", accountId, message: feedback, draftId: "feedback:local" },
        { kind: "user", surface: "app" },
      );
      expect(server.sent).toHaveLength(1);
    }).pipe(Effect.provide(layer())),
  );
});

it("declining the report does not erase the crash-loop counter", () => {
  const log = createLocalDiagnostics(temp());
  log.begin();
  log.crash("renderer-crash");
  log.acknowledge();
  log.crash("renderer-crash");
  log.acknowledge();
  expect(log.crash("renderer-crash")).toBe(true);
});

it("resets a legacy database before migrations without deleting accounts", () => {
  const dir = temp();
  const db = new DatabaseSync(join(dir, "mail.db"));
  db.exec(MIGRATIONS[0] ?? "");
  db.prepare(
    "INSERT INTO accounts(id,provider,email,created_at,sync_cursor,last_synced_at) VALUES (?,?,?,?,?,?)",
  ).run("gmail:legacy@example.com", "gmail", "legacy@example.com", 1, "cursor", 100);
  db.close();
  expect(() => resetLocalCache(dir)).not.toThrow();
  const reopened = new DatabaseSync(join(dir, "mail.db"));
  try {
    expect(
      reopened.prepare("SELECT email,sync_cursor,last_synced_at FROM accounts").get(),
    ).toMatchObject({ email: "legacy@example.com", sync_cursor: null, last_synced_at: null });
  } finally {
    reopened.close();
  }
});

it("keeps both remote draft ids when resetting a cache", () => {
  const dir = temp();
  const db = new DatabaseSync(join(dir, "mail.db"));
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES (?,?,?,?)").run(
    "a",
    "gmail",
    "test@example.com",
    1,
  );
  db.prepare(
    "INSERT INTO drafts(id,account_id,message_json,updated_at,remote_draft_id,remote_message_id) VALUES (?,?,?,?,?,?)",
  ).run("d", "a", "{}", 1, "remote-draft", "remote-message");
  db.close();
  resetLocalCache(dir);
  const after = new DatabaseSync(join(dir, "mail.db"));
  try {
    expect(
      after.prepare("SELECT remote_draft_id,remote_message_id FROM drafts").get(),
    ).toMatchObject({ remote_draft_id: "remote-draft", remote_message_id: "remote-message" });
  } finally {
    after.close();
  }
});
it("diagnostic markers cannot block startup when their temporary file is unwritable", () => {
  const dir = temp();
  const log = createLocalDiagnostics(dir);
  // A directory at the staging-file path deterministically produces EISDIR, even as root.
  mkdirSync(join(dir, "health.json.tmp"));
  expect(() => log.begin()).not.toThrow();
  expect(() => log.crash("renderer-crash")).not.toThrow();
  expect(() => log.finish()).not.toThrow();
});

it("salvages every migrated non-cache table from a database with a damaged cache page", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(file);
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  const columnSchema = Schema.Array(
    Schema.Struct({
      name: Schema.String,
      type: Schema.String,
      notnull: Schema.Number,
      pk: Schema.Number,
      dflt_value: Schema.NullOr(Schema.String),
    }),
  );
  const retained = RECOVERY_TABLES.filter((table) =>
    db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table),
  );
  for (const table of retained) {
    const columns = Schema.decodeUnknownSync(columnSchema)(
      db.prepare(`PRAGMA table_info(${table})`).all(),
    ).filter(
      (c) => (c.notnull || c.pk) && c.dflt_value === null && !(c.pk && c.type === "INTEGER"),
    );
    const values = columns.map((c) => {
      if (c.type === "INTEGER") return 1;
      if (c.name === "account_id" || (table === "accounts" && c.name === "id")) return "account";
      if (c.name === "provider") return "gmail";
      if (c.name === "modify") return "allow";
      if (c.name === "kind") return "new";
      if (c.name === "source") return "local";
      if (c.name === "thread_id") return "thread";
      if (c.name === "email" || c.name === "address") return "person@example.com";
      if (c.name.endsWith("_json"))
        return ["to_json", "cc_json", "bcc_json", "scopes_json"].includes(c.name) ? "[]" : "{}";
      return `${table}-${c.name}`;
    });
    db.prepare(
      `INSERT INTO ${table}(${columns.map((c) => c.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    ).run(...values);
  }
  db.exec("UPDATE signature_defaults SET signature_id=(SELECT id FROM named_signatures LIMIT 1)");
  db.exec("UPDATE drafts SET local_only=1,sync_error='Keep these local edits'");
  const expected = new Map(
    retained.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
  );
  const root = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='messages'")
    .get()?.rootpage;
  const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof pageSize !== "number")
    throw new Error("Missing page metadata");
  db.close();
  const bytes = readFileSync(file);
  bytes[(root - 1) * pageSize] = 0;
  writeFileSync(file, bytes);
  expect(checkLocalDatabase(dir)).toBe("corrupt");
  const result = resetLocalCache(dir);
  expect(result.kind).toBe("recovered");
  expect(checkLocalDatabase(dir)).toBe("ok");
  const fresh = new DatabaseSync(file);
  try {
    for (const table of retained)
      expect(fresh.prepare(`SELECT * FROM ${table}`).all()).toEqual(expected.get(table));
  } finally {
    fresh.close();
  }
  if (result.kind === "recovered") expect(readFileSync(result.backup)).toEqual(bytes);
});

it("skips unreadable preference rows and continues copying later readable pages", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(file);
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  for (let i = 1; i <= 60; i++)
    db.prepare("INSERT INTO prefs(key,value_json) VALUES (?,?)").run(
      `pref-${i}`,
      JSON.stringify("x".repeat(1500)),
    );
  const root = db.prepare("SELECT rootpage FROM sqlite_master WHERE name='prefs'").get()?.rootpage;
  const pageSize = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof pageSize !== "number")
    throw new Error("Missing page metadata");
  db.close();
  const bytes = readFileSync(file);
  const offset = (root - 1) * pageSize;
  expect(bytes[offset]).toBe(5);
  const firstCell = bytes.readUInt16BE(offset + 12);
  const child = bytes.readUInt32BE(offset + firstCell);
  bytes[(child - 1) * pageSize] = 0;
  writeFileSync(file, bytes);
  const damaged = new DatabaseSync(file);
  const readable: string[] = [];
  for (let id = 1; id <= 60; id++) {
    try {
      const row = damaged.prepare("SELECT key FROM prefs WHERE rowid=?").get(id);
      if (typeof row?.key === "string") readable.push(row.key);
    } catch {
      /* This page is the deliberately unreadable fixture. */
    }
  }
  damaged.close();
  expect(readable.length).toBeGreaterThan(0);
  expect(readable.length).toBeLessThan(60);
  const result = resetLocalCache(dir);
  expect(result).toMatchObject({ kind: "recovered" });
  if (result.kind === "recovered") expect(result.skipped).toBeGreaterThan(0);
  const fresh = new DatabaseSync(file);
  try {
    expect(
      fresh
        .prepare("SELECT key FROM prefs ORDER BY key")
        .all()
        .map((r) => r.key),
    ).toEqual(readable.toSorted());
  } finally {
    fresh.close();
  }
});

it("enumerates every migrated plain table as retained state or disposable cache", () => {
  const db = new DatabaseSync(":memory:");
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  const cache = new Set([
    "body_cache_budget",
    "messages",
    "labels",
    "derived",
    "derived_jobs",
    "derived_chunks",
    "server_contacts",
    "contact_candidates",
    "contact_completion_fts",
    "message_badges",
    "message_search_meta",
    "contact_organizations",
    "contact_sync",
    "contact_groups",
    "contact_photos",
    "sent_recipients",
    "seen_incoming",
    "incoming_state",
    "semantic_jobs",
    "vector_items",
    "cache_maintenance",
    "backfill",
    "mailed_addresses",
    "pending_notifications",
    "notification_buttons",
    "messages_word_positions",
    "derived_word_positions",
    "messages_words",
    "messages_word_positions",
    "derived_word_positions",
    "derived_words",
    "search_word_index",
    "search_word_rows",
    "calendar_invites",
  ]);
  try {
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
      if (
        typeof row.name !== "string" ||
        /^(?:sqlite_|messages_fts|derived_fts|contact_candidates_fts|contact_organizations_fts|contact_completion_fts_|messages_words_|derived_words_)/.test(
          row.name,
        )
      )
        continue;
      expect([...RECOVERY_TABLES, ...cache]).toContain(row.name);
    }
  } finally {
    db.close();
  }
});

it("preserves the old WAL/SHM and salvages records committed only in the WAL", () => {
  const sourceDir = temp();
  const dir = temp();
  const sourceFile = join(sourceDir, "mail.db");
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(sourceFile);
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  const root = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='messages'")
    .get()?.rootpage;
  const size = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof size !== "number") throw new Error("No page metadata");
  db.exec("PRAGMA journal_mode=WAL");
  db.prepare("INSERT INTO prefs(key,value_json) VALUES (?,?)").run("wal-only", "true");
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${sourceFile}${suffix}`)).toBe(true);
      copyFileSync(`${sourceFile}${suffix}`, `${file}${suffix}`);
    }
  } finally {
    db.close();
  }
  const beforeWal = readFileSync(`${file}-wal`);
  const bytes = readFileSync(file);
  bytes[(root - 1) * size] = 0;
  writeFileSync(file, bytes);
  expect(checkLocalDatabase(dir)).toBe("corrupt");
  const result = resetLocalCache(dir);
  expect(result.kind).toBe("recovered");
  if (result.kind === "recovered") {
    expect(readFileSync(`${result.backup}-wal`)).toEqual(beforeWal);
    expect(existsSync(`${result.backup}-shm`)).toBe(true);
  }
  const fresh = new DatabaseSync(file);
  try {
    expect(
      fresh.prepare("SELECT value_json FROM prefs WHERE key='wal-only'").get()?.value_json,
    ).toBe("true");
  } finally {
    fresh.close();
  }
});

it("keeps a readable account when only its optional profile page is unreadable", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(file);
  for (const script of MIGRATIONS) applyNativeMigration(db, script);
  db.prepare("INSERT INTO profiles(id,name,icon,color,position) VALUES (?,?,?,?,?)").run(
    "p",
    "Work",
    "mail",
    "blue",
    0,
  );
  db.prepare(
    "INSERT INTO accounts(id,provider,email,created_at,profile_id) VALUES (?,?,?,?,?)",
  ).run("gmail:test@example.com", "gmail", "test@example.com", 1, "p");
  const root = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='profiles'")
    .get()?.rootpage;
  const size = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof size !== "number") throw new Error("No page metadata");
  db.close();
  const bytes = readFileSync(file);
  bytes[(root - 1) * size] = 0;
  writeFileSync(file, bytes);
  resetLocalCache(dir);
  const fresh = new DatabaseSync(file);
  try {
    expect(fresh.prepare("SELECT email,profile_id FROM accounts").get()).toMatchObject({
      email: "test@example.com",
      profile_id: null,
    });
  } finally {
    fresh.close();
  }
});

it("refuses corrupt database replacement while another connection holds a read transaction", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const seed = new DatabaseSync(file);
  for (const script of MIGRATIONS) applyNativeMigration(seed, script);
  const root = seed
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='messages'")
    .get()?.rootpage;
  const size = seed.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof size !== "number") throw new Error("No page metadata");
  seed.close();
  const bytes = readFileSync(file);
  bytes[(root - 1) * size] = 0;
  writeFileSync(file, bytes);
  const other = new DatabaseSync(file);
  other.exec("BEGIN");
  other.prepare("SELECT name FROM sqlite_master").get();
  try {
    expect(() => resetLocalCache(dir)).toThrow("Close other OpenMail processes");
    expect(readFileSync(file)).toEqual(bytes);
  } finally {
    other.close();
  }
});

it("cache reset removes company metadata and repairs a damaged organization FTS index", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(file);
  for (const migration of MIGRATIONS) applyNativeMigration(db, migration);
  db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,?)").run(
    "gmail:me@example.com",
    "gmail",
    "me@example.com",
    0,
  );
  db.prepare("INSERT INTO contact_organizations(account_id,address,company) VALUES(?,?,?)").run(
    "gmail:me@example.com",
    "john@example.com",
    "Private company",
  );
  db.exec("INSERT INTO contact_organizations_fts(contact_organizations_fts) VALUES ('delete-all')");
  db.close();
  expect(resetLocalCache(dir)).toEqual({ kind: "reset" });
  const reopened = new DatabaseSync(file);
  try {
    expect(reopened.prepare("SELECT company FROM contact_organizations").all()).toEqual([]);
    expect(
      reopened
        .prepare(
          "SELECT rowid FROM contact_organizations_fts WHERE contact_organizations_fts MATCH 'Private'",
        )
        .all(),
    ).toEqual([]);
    expect(() =>
      reopened.exec(
        "INSERT INTO contact_organizations_fts(contact_organizations_fts,rank) VALUES('integrity-check',1)",
      ),
    ).not.toThrow();
    expect(reopened.prepare("SELECT id FROM accounts").all()).toHaveLength(1);
  } finally {
    reopened.close();
  }
});
