import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { SqlClient } from "effect/sql";

/**
 * node:sqlite instead of better-sqlite3: it ships inside both Node and
 * Electron, so the app and the CLI share one database without a native module
 * rebuilt per ABI. `@effect/sql-sqlite-node` wraps it.
 */

// Append-only. Each entry runs once, in order, tracked by `PRAGMA user_version`.
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    sync_cursor TEXT,
    last_synced_at INTEGER
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    from_name TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    date INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    body_text TEXT NOT NULL,
    body_html TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    attachments_json TEXT NOT NULL,
    is_unread INTEGER NOT NULL,
    is_starred INTEGER NOT NULL
  );
  CREATE INDEX messages_account_date ON messages(account_id, date DESC);
  CREATE INDEX messages_date ON messages(date DESC);
  CREATE INDEX messages_thread ON messages(thread_id);

  -- trigram tokenizer: substring search that works for Chinese without a
  -- word segmenter. Queries under three characters fall back to LIKE.
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    subject, from_name, from_addr, body_text,
    content='messages', content_rowid='rowid', tokenize='trigram'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
    VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.body_text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.body_text);
  END;
  CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.body_text);
    INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
    VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.body_text);
  END;
  `,
  `
  -- Profiles group accounts (Work, Personal), like Arc spaces or Mimestream profiles.
  CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT NOT NULL,
    color TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  ALTER TABLE accounts ADD COLUMN profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL;
  ALTER TABLE accounts ADD COLUMN last_sync_error TEXT;

  -- User labels (Gmail) and custom folders (Outlook). The id is the value that
  -- appears in messages.labels_json.
  CREATE TABLE labels (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (account_id, id)
  );

  CREATE INDEX messages_account_thread ON messages(account_id, thread_id);
  `,
  `
  -- Provider settings that are not secret (IMAP host, port, username). The
  -- password stays in the keychain next to OAuth refresh tokens.
  ALTER TABLE accounts ADD COLUMN settings_json TEXT;
  -- Set when the provider rejects the stored credentials or lacks a scope;
  -- the app shows a sign-in-again prompt until a new sign-in clears it.
  ALTER TABLE accounts ADD COLUMN needs_reauth INTEGER NOT NULL DEFAULT 0;

  -- Changes applied locally and waiting to reach the provider. Rows leave the
  -- queue when the provider accepts them or rejects them for good.
  CREATE TABLE pending_ops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    provider_id TEXT NOT NULL,
    op_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );

  -- Every change to mail, by whom (app, cli, mcp) and what.
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    account_id TEXT,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL
  );
  `,
  `
  -- What an agent (MCP client, automation rule) may do without asking.
  -- name '*' is the default for agents without their own row.
  CREATE TABLE agent_policies (
    name TEXT PRIMARY KEY,
    modify TEXT NOT NULL CHECK (modify IN ('off', 'propose', 'allow'))
  );

  -- Commands an agent asked for that wait for a person in the app. Sending
  -- always lands here when an agent asks.
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    actor_json TEXT NOT NULL,
    command_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    decided_at INTEGER
  );
  CREATE INDEX proposals_pending ON proposals(status, created_at);
  `,
  `
  -- Drafts being written. Separate from messages, which mirror the provider:
  -- a draft exists before the provider has an id for it, and it keeps what
  -- messages does not store (Bcc, attachment content, the Markdown flag). The
  -- provider's copy shows up in messages (label DRAFT) after a pull and is
  -- linked back by remote_message_id.
  CREATE TABLE drafts (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
    remote_draft_id TEXT,
    remote_message_id TEXT,
    -- Names and sizes of the attachments as last pushed, so a push re-uploads
    -- them only when they changed.
    pushed_attachments TEXT
  );
  CREATE INDEX drafts_remote ON drafts(account_id, remote_message_id);
  CREATE INDEX drafts_proposal ON drafts(proposal_id);

  -- A queued op being pushed right now, by this process or another (app, CLI
  -- and MCP share the queue). Claims older than two minutes count as dead.
  ALTER TABLE pending_ops ADD COLUMN claimed_at INTEGER;

  -- App preferences shared by every surface. One JSON value per key.
  CREATE TABLE prefs (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  -- Signatures per sending address. source 'local' is typed in openmail;
  -- provider signatures (Gmail sendAs) will sync in as their own source.
  CREATE TABLE signatures (
    address TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('new', 'reply')),
    source TEXT NOT NULL DEFAULT 'local',
    text TEXT NOT NULL,
    PRIMARY KEY (address, kind, source)
  );

  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- Addresses the person hid from recipient suggestions. Lower case.
  CREATE TABLE hidden_contacts (
    address TEXT PRIMARY KEY
  );
  `,
  `
  -- Senders whose mail loads remote images without asking: a whole address
  -- ("news@shop.com") or a domain ("shop.com", which covers its subdomains).
  -- Lower case. Known trackers stay blocked for these senders too.
  CREATE TABLE image_senders (
    entry TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE label_preferences (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL, visible INTEGER NOT NULL, favorite INTEGER NOT NULL, color TEXT,
    PRIMARY KEY(account_id, id)
  );
  CREATE TABLE account_organization (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    categories INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE thread_reminders (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, due_at INTEGER, woken_at INTEGER, wake_pending INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account_id, thread_id)
  );
  CREATE INDEX thread_reminders_due ON thread_reminders(due_at);
  CREATE TABLE send_as (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, name TEXT NOT NULL, is_default INTEGER NOT NULL, signature TEXT NOT NULL,
    PRIMARY KEY(account_id, address)
  );
  `,
];

/**
 * Splits a migration into statements. node:sqlite has no exec through the
 * Effect client, and `prepare` silently drops everything after the first
 * statement. A `;` ends a statement unless it sits in a string, a comment or
 * a CREATE TRIGGER body, which runs to its closing `END;`. A CASE ... END
 * right before a `;` inside a trigger body would confuse this; no migration
 * has one.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let start = 0;
  // The statement so far without comments and string contents, for the
  // trigger check.
  let code = "";
  let i = 0;
  while (i < script.length) {
    const c = script[i];
    const skipTo = (end: number) => (end === -1 ? script.length : end);
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote ('') reads as two adjacent strings, which is fine here.
      i = skipTo(script.indexOf(c, i + 1)) + 1;
      code += "''";
    } else if (c === "-" && script[i + 1] === "-") {
      i = skipTo(script.indexOf("\n", i));
    } else if (c === "/" && script[i + 1] === "*") {
      i = skipTo(script.indexOf("*/", i + 2)) + 2;
    } else {
      code += c;
      i++;
      if (c === ";" && !(isTrigger(code) && !/\bEND\s*;$/i.test(code))) {
        const statement = script.slice(start, i).trim();
        if (code.trim() !== ";") out.push(statement);
        start = i;
        code = "";
      }
    }
  }
  if (code.trim()) out.push(script.slice(start).trim());
  return out;
}

const isTrigger = (code: string) => /^\s*CREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(code);

const UserVersion = Schema.Struct({ user_version: Schema.Number });

/**
 * Runs pending migrations, one transaction each. The version is read inside
 * the transaction (BEGIN IMMEDIATE holds the write lock), so the app and the
 * CLI opening an old database at the same moment never run a step twice.
 */
const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Per connection, and a no-op inside a transaction, so it goes first.
  yield* sql`PRAGMA foreign_keys = ON`;
  const step = sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql`PRAGMA user_version`;
      const { user_version: version } = yield* Schema.decodeUnknownEffect(UserVersion)(rows[0]);
      const migration = MIGRATIONS[version];
      if (migration === undefined) return false;
      for (const statement of splitStatements(migration)) yield* sql.unsafe(statement).unprepared;
      yield* sql.unsafe(`PRAGMA user_version = ${version + 1}`).unprepared;
      return true;
    }),
  );
  while (yield* step) {
    // Next migration.
  }
});

/**
 * The database as an Effect SqlClient, migrated before anything uses it. The
 * client turns on WAL and a 5 s busy timeout: the app and the CLI write
 * concurrently, and a second writer should wait instead of failing with
 * SQLITE_BUSY. `":memory:"` gives a fresh database for tests; any other name
 * gets its parent directory created first.
 */
export function databaseLayer(
  filename: string,
): Layer.Layer<SqlClient.SqlClient, never, FileSystem.FileSystem | Path.Path> {
  const ensureDir = Effect.gen(function* () {
    if (filename === ":memory:") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.orDie(fs.makeDirectory(path.dirname(filename), { recursive: true }));
  });
  return Layer.effectDiscard(Effect.orDie(migrate)).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: 5000 })),
    Layer.provide(Layer.effectDiscard(ensureDir)),
  );
}
