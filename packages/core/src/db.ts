import { SqliteClient } from "@effect/sql-sqlite-node";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
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
  CREATE TABLE snoozed_messages (
    account_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    wake_pending INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account_id, provider_id),
    FOREIGN KEY(account_id, thread_id) REFERENCES thread_reminders(account_id, thread_id) ON DELETE CASCADE
  );
  CREATE INDEX snoozed_messages_thread ON snoozed_messages(account_id, thread_id);
  `,
  `
  CREATE TABLE derived_jobs (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 1,
    pipeline_version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
    claimed_at INTEGER, claim TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, note TEXT
  );
  CREATE INDEX derived_jobs_pending ON derived_jobs(status, retry_at);
  CREATE TABLE derived_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    text TEXT NOT NULL, provenance_json TEXT NOT NULL
  );
  CREATE INDEX derived_chunks_message ON derived_chunks(message_id);
  CREATE VIRTUAL TABLE derived_fts USING fts5(text,
    content='derived_chunks', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER derived_ai AFTER INSERT ON derived_chunks BEGIN
    INSERT INTO derived_fts(rowid,text) VALUES(new.id,new.text);
  END;
  CREATE TRIGGER derived_ad AFTER DELETE ON derived_chunks BEGIN
    INSERT INTO derived_fts(derived_fts,rowid,text) VALUES('delete',old.id,old.text);
  END;
  CREATE TRIGGER derived_au AFTER UPDATE ON derived_chunks BEGIN
    INSERT INTO derived_fts(derived_fts,rowid,text) VALUES('delete',old.id,old.text);
    INSERT INTO derived_fts(rowid,text) VALUES(new.id,new.text);
  END;
  CREATE TRIGGER media_message_insert AFTER INSERT ON messages
    WHEN new.body_html LIKE '%cid:%' OR EXISTS(SELECT 1 FROM json_each(new.attachments_json)
      WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%'
        OR lower(json_extract(value,'$.mimeType'))='application/pdf') BEGIN
    INSERT INTO derived_jobs(message_id) VALUES(new.id);
  END;
  CREATE TRIGGER media_message_update AFTER UPDATE OF attachments_json,body_html ON messages
    WHEN old.attachments_json != new.attachments_json OR old.body_html != new.body_html BEGIN
    DELETE FROM derived_chunks WHERE message_id=new.id;
    INSERT INTO derived_jobs(message_id) SELECT new.id
      WHERE new.body_html LIKE '%cid:%' OR EXISTS(SELECT 1 FROM json_each(new.attachments_json)
        WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%'
          OR lower(json_extract(value,'$.mimeType'))='application/pdf')
        OR EXISTS(SELECT 1 FROM derived_jobs WHERE message_id=new.id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1, status='queued',
      claim=NULL, claimed_at=NULL, attempts=0, retry_at=0, note=NULL;
  END;
  INSERT INTO derived_jobs(message_id) SELECT id FROM messages m
    WHERE m.body_html LIKE '%cid:%' OR EXISTS(SELECT 1 FROM json_each(m.attachments_json)
      WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%'
        OR lower(json_extract(value,'$.mimeType'))='application/pdf');
  `,
  `
  ALTER TABLE messages ADD COLUMN calendar_hint INTEGER;
  -- The reader must not fetch raw MIME for every message from an older cache.
  UPDATE messages SET calendar_hint = EXISTS (
    SELECT 1 FROM json_each(messages.attachments_json) a
    WHERE lower(trim(json_extract(a.value, '$.mimeType'))) = 'text/calendar'
      OR lower(json_extract(a.value, '$.mimeType')) LIKE 'text/calendar;%'
      OR lower(json_extract(a.value, '$.filename')) LIKE '%.ics'
  );
  -- Migration 9: snapshots are replaced only after every provider page succeeds.
  CREATE TABLE server_contacts (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, name TEXT NOT NULL,
    PRIMARY KEY(account_id, address)
  );
  CREATE TABLE contact_sync (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    refreshed_at INTEGER, attempted_at INTEGER NOT NULL,
    error TEXT, scope_missing INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE seen_incoming (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    identity TEXT NOT NULL,
    PRIMARY KEY(account_id, identity)
  ) WITHOUT ROWID;
  CREATE TABLE incoming_state (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    inbox_cursor TEXT,
    initial_sync_complete INTEGER NOT NULL DEFAULT 0 CHECK(initial_sync_complete IN (0,1)),
    poll_error TEXT
  );
  -- Preserve live accounts' bookmarks and deduplication, then remove legacy prefs.
  INSERT INTO incoming_state(account_id,inbox_cursor,initial_sync_complete)
    SELECT a.id, c.value_json,
      CASE WHEN i.key IS NOT NULL THEN i.value_json='true' ELSE a.last_synced_at IS NOT NULL END
    FROM accounts a LEFT JOIN prefs c ON c.key='system:inbox:'||a.id
      LEFT JOIN prefs i ON i.key='system:initial:'||a.id;
  INSERT OR IGNORE INTO seen_incoming(account_id,identity)
    SELECT a.id, json_extract(substr(p.key,13),'$[1]')
    FROM prefs p JOIN accounts a ON a.id=CASE WHEN json_valid(substr(p.key,13))
      THEN json_extract(substr(p.key,13),'$[0]') END
    WHERE p.key LIKE 'system:seen:%' AND json_valid(substr(p.key,13))
      AND typeof(json_extract(substr(p.key,13),'$[1]'))='text';
  DELETE FROM prefs WHERE key LIKE 'system:seen:%' OR key LIKE 'system:inbox:%' OR key LIKE 'system:initial:%';
  `,
  `
  CREATE TABLE semantic_jobs (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL DEFAULT 1, pipeline_version TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed')),
    claimed_at INTEGER, claim TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0, note TEXT
  );
  CREATE INDEX semantic_jobs_pending ON semantic_jobs(status,retry_at);
  CREATE TABLE vector_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('text','image')),
    version TEXT NOT NULL, provenance_json TEXT NOT NULL
  );
  CREATE INDEX vector_items_message ON vector_items(message_id);
  CREATE TRIGGER semantic_message_insert AFTER INSERT ON messages BEGIN
    INSERT INTO semantic_jobs(message_id) VALUES(new.id);
  END;
  CREATE TRIGGER semantic_message_update AFTER UPDATE OF body_text,body_html,attachments_json ON messages
    WHEN old.body_text != new.body_text OR old.body_html != new.body_html OR old.attachments_json != new.attachments_json BEGIN
    DELETE FROM vector_items WHERE message_id=new.id;
    INSERT INTO semantic_jobs(message_id) VALUES(new.id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',claim=NULL,
      claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
  CREATE TRIGGER semantic_media_insert AFTER INSERT ON derived_chunks BEGIN
    INSERT INTO semantic_jobs(message_id) VALUES(new.message_id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',claim=NULL,
      claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
  INSERT INTO semantic_jobs(message_id) SELECT id FROM messages;
  `,
  `
  ALTER TABLE derived_jobs ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE semantic_jobs ADD COLUMN priority_at INTEGER NOT NULL DEFAULT 0;
  UPDATE derived_jobs SET priority_at=(SELECT date FROM messages WHERE id=message_id);
  UPDATE semantic_jobs SET priority_at=(SELECT date FROM messages WHERE id=message_id);
  CREATE INDEX derived_jobs_priority ON derived_jobs(status,priority_at DESC,message_id);
  CREATE INDEX semantic_jobs_priority ON semantic_jobs(status,priority_at DESC,message_id);
  CREATE INDEX derived_jobs_lease ON derived_jobs(status,claimed_at);
  CREATE INDEX semantic_jobs_lease ON semantic_jobs(status,claimed_at);
  CREATE TRIGGER derived_priority_insert AFTER INSERT ON derived_jobs BEGIN
    UPDATE derived_jobs SET priority_at=(SELECT date FROM messages WHERE id=new.message_id) WHERE message_id=new.message_id;
  END;
  CREATE TRIGGER semantic_priority_insert AFTER INSERT ON semantic_jobs BEGIN
    UPDATE semantic_jobs SET priority_at=(SELECT date FROM messages WHERE id=new.message_id) WHERE message_id=new.message_id;
  END;
  CREATE TRIGGER message_priority_update AFTER UPDATE OF date ON messages WHEN old.date!=new.date BEGIN
    UPDATE derived_jobs SET priority_at=new.date WHERE message_id=new.id;
    UPDATE semantic_jobs SET priority_at=new.date WHERE message_id=new.id;
  END;
  `,
  // Migration 13: release cache and pagination.
  `
  DROP TRIGGER messages_au;
  CREATE TRIGGER messages_au AFTER UPDATE OF subject,from_name,from_addr,body_text ON messages BEGIN
    INSERT INTO messages_fts(messages_fts,rowid,subject,from_name,from_addr,body_text)
    VALUES ('delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text);
    INSERT INTO messages_fts(rowid,subject,from_name,from_addr,body_text)
    VALUES (new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
  END;
  ALTER TABLE messages ADD COLUMN body_cached INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE messages ADD COLUMN list_date INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN body_opened_at INTEGER;
  CREATE INDEX messages_cache_date ON messages(account_id,body_cached,date);
  CREATE TABLE cache_maintenance (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    evicted_at INTEGER NOT NULL
  );
  DROP TRIGGER media_message_update;
  CREATE TRIGGER media_message_update AFTER UPDATE OF attachments_json,body_html ON messages
    WHEN (old.attachments_json != new.attachments_json OR old.body_html != new.body_html)
      AND old.body_cached = new.body_cached BEGIN
    DELETE FROM derived_chunks WHERE message_id=new.id;
    INSERT INTO derived_jobs(message_id) SELECT new.id
      WHERE new.body_html LIKE '%cid:%' OR EXISTS(SELECT 1 FROM json_each(new.attachments_json)
        WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%'
          OR lower(json_extract(value,'$.mimeType'))='application/pdf')
        OR EXISTS(SELECT 1 FROM derived_jobs WHERE message_id=new.id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',
        claim=NULL,claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
  DROP TRIGGER semantic_message_update;
  CREATE TRIGGER semantic_message_update AFTER UPDATE OF body_text,body_html,attachments_json ON messages
    WHEN (old.body_text != new.body_text OR old.body_html != new.body_html OR old.attachments_json != new.attachments_json)
      AND old.body_cached = new.body_cached BEGIN
    DELETE FROM vector_items WHERE message_id=new.id;
    INSERT INTO semantic_jobs(message_id) VALUES(new.id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',claim=NULL,
      claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
  UPDATE messages AS m SET list_date=MAX(m.date,COALESCE((SELECT r.woken_at FROM thread_reminders r
    JOIN snoozed_messages s ON s.account_id=r.account_id AND s.thread_id=r.thread_id
    WHERE s.account_id=m.account_id AND s.provider_id=m.provider_id),0));
  CREATE INDEX messages_list_date_id ON messages(list_date DESC, id DESC);
  CREATE INDEX messages_account_list_date_id ON messages(account_id, list_date DESC, id DESC);
  CREATE INDEX messages_thread_list_date_id ON messages(account_id, thread_id, list_date DESC, id DESC);
  CREATE TRIGGER reminders_list_date AFTER UPDATE OF woken_at ON thread_reminders BEGIN
    UPDATE messages SET list_date=MAX(date,COALESCE(new.woken_at,0))
    WHERE account_id=new.account_id AND thread_id=new.thread_id
      AND EXISTS (SELECT 1 FROM snoozed_messages s WHERE s.account_id=messages.account_id AND s.provider_id=messages.provider_id);
  END;
  CREATE TRIGGER snoozed_list_date_insert AFTER INSERT ON snoozed_messages BEGIN
    UPDATE messages SET list_date=MAX(date,COALESCE((SELECT woken_at FROM thread_reminders
      WHERE account_id=new.account_id AND thread_id=new.thread_id),0))
    WHERE account_id=new.account_id AND provider_id=new.provider_id;
  END;
  CREATE TRIGGER snoozed_list_date_delete AFTER DELETE ON snoozed_messages BEGIN
    UPDATE messages SET list_date=date WHERE account_id=old.account_id AND provider_id=old.provider_id;
  END;
  CREATE TABLE cache_windows (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    label TEXT NOT NULL, days INTEGER CHECK(days IS NULL OR days > 0),
    PRIMARY KEY(account_id, label)
  );
  CREATE TABLE backfill (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    cursor TEXT, before_date INTEGER NOT NULL, fetched INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, next_run_at INTEGER NOT NULL DEFAULT 0
  );
  `,
  // Migration 14 (unreleased): NULL is unknown; [] means fetched with no Reply-To.
  `ALTER TABLE messages ADD COLUMN reply_to_json TEXT;`,
  // Migration 15: reading metadata. Backfill recipients once, never scan mail on hover/read.
  `ALTER TABLE messages ADD COLUMN web_link TEXT;
  CREATE TABLE mailed_addresses (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    PRIMARY KEY(account_id, address)
  ) WITHOUT ROWID;
  INSERT OR IGNORE INTO mailed_addresses(account_id,address)
    SELECT m.account_id, lower(trim(json_extract(recipient.value,'$.address')))
    FROM messages m, json_each(m.to_json) recipient
    WHERE EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value='SENT')
    UNION
    SELECT m.account_id, lower(trim(json_extract(recipient.value,'$.address')))
    FROM messages m, json_each(m.cc_json) recipient
    WHERE EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value='SENT');`,
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
  // Per connection, and a no-op inside a transaction, so they go first. The
  // app, the CLI and a restarting app can share the file; wait for a lock
  // instead of failing at once.
  yield* sql`PRAGMA busy_timeout = 5000`;
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
export class DatabaseCapabilities extends Context.Service<
  DatabaseCapabilities,
  { readonly vectors: boolean }
>()("openmail/DatabaseCapabilities") {}

export interface DatabaseOptions {
  /** Resolve the local extension. Passing null intentionally disables vectors. */
  readonly vectorExtension?: (() => string) | null;
}

export function databaseLayer(
  filename: string,
  options: DatabaseOptions = {},
): Layer.Layer<
  SqlClient.SqlClient | SqliteClient.SqliteClient | DatabaseCapabilities,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const ensureDir = Effect.gen(function* () {
    if (filename === ":memory:") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* Effect.orDie(fs.makeDirectory(path.dirname(filename), { recursive: true }));
  });
  const initialize = Effect.gen(function* () {
    yield* Effect.orDie(migrate);
    const sqlite = yield* SqliteClient.SqliteClient;
    const sql = yield* SqlClient.SqlClient;
    const vectors = yield* Effect.gen(function* () {
      if (options.vectorExtension === null) return false;
      const path = options.vectorExtension
        ? yield* Effect.try(options.vectorExtension)
        : yield* Effect.tryPromise(async () => (await import("sqlite-vec")).getLoadablePath());
      // SQLite dlopen bypasses Electron's ASAR filesystem wrapper.
      yield* sqlite.loadExtension(
        path.replace(/([/\\])app\.asar([/\\])/u, "$1app.asar.unpacked$2"),
      );
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_text_vectors USING vec0(embedding float[384])`;
      yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS derived_image_vectors USING vec0(embedding float[512])`;
      // A connection without vec0 can delete messages. Clean orphaned vectors
      // when a capable connection next opens the database.
      yield* sql`DELETE FROM derived_text_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
      yield* sql`DELETE FROM derived_image_vectors WHERE rowid NOT IN (SELECT id FROM vector_items)`;
      return true;
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning("sqlite-vec unavailable; mail and media text search remain enabled").pipe(
          Effect.as(false),
        ),
      ),
    );
    return DatabaseCapabilities.of({ vectors });
  });
  return Layer.effect(DatabaseCapabilities, initialize).pipe(
    Layer.provideMerge(SqliteClient.layer({ filename, busyTimeout: 5000 })),
    Layer.provide(Layer.effectDiscard(ensureDir)),
  );
}
