import { Clock, Context, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { isSqlError } from "effect/sql/SqlError";

/** Shared migrations and SQL initialization. Platform drivers provide SqlClient. */

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
  // Migration 16: arrivals survive muted hours and desktop restarts.
  `CREATE TABLE pending_notifications (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    digest INTEGER NOT NULL CHECK(digest IN (0,1)),
    enqueued_at INTEGER NOT NULL
  );
  CREATE INDEX pending_notifications_enqueued ON pending_notifications(enqueued_at);`,
  // Migration 17: existing templates have no blind-copy recipients.
  `ALTER TABLE templates ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';`,
  // Migration 18: local account controls; cached mail and secrets remain intact.
  `ALTER TABLE accounts ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE accounts ADD COLUMN description TEXT NOT NULL DEFAULT '';
   ALTER TABLE accounts ADD COLUMN color TEXT;
   ALTER TABLE accounts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
   UPDATE accounts SET position = (SELECT COUNT(*) FROM accounts b
     WHERE b.created_at < accounts.created_at OR (b.created_at = accounts.created_at AND b.id < accounts.id));
   CREATE TABLE notification_buttons (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, actions_json TEXT NOT NULL);`,
  // Migration 19: non-secret OAuth grant metadata. Refresh tokens remain in the keychain.
  `CREATE TABLE account_oauth_scopes (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    scopes_json TEXT NOT NULL
  );`,
  // Migration 20: provider label visibility, ordered favorites and Gmail rule recovery.
  `ALTER TABLE labels ADD COLUMN label_list_visibility TEXT;
   ALTER TABLE labels ADD COLUMN message_list_visibility TEXT;
   ALTER TABLE label_preferences ADD COLUMN position REAL NOT NULL DEFAULT 0;
   CREATE TABLE filter_restorations (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     backup_json TEXT NOT NULL
   );`,
  // Migration 21: last pushed draft organization, independent of body autosaves.
  `ALTER TABLE drafts ADD COLUMN pushed_organization TEXT;`,
  // Migration 22 (unreleased): saved contact groups, bounded photos and indexed sent recipients.
  `CREATE TABLE contact_groups (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id TEXT NOT NULL, name TEXT NOT NULL, members_json TEXT NOT NULL,
    PRIMARY KEY(account_id,id)
  );
  CREATE TABLE contact_photos (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, url TEXT NOT NULL, data_url TEXT, last_used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account_id,address)
  );
  CREATE INDEX contact_photos_lru ON contact_photos(last_used DESC, account_id, address) WHERE data_url IS NOT NULL;
  CREATE TABLE sent_recipients (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, from_addr TEXT NOT NULL, sent_at REAL NOT NULL,
    PRIMARY KEY(message_id,address)
  ) WITHOUT ROWID;
  CREATE INDEX sent_recipients_address ON sent_recipients(address,account_id,from_addr,sent_at);
  INSERT OR IGNORE INTO sent_recipients
    WITH sent AS MATERIALIZED (
      SELECT id,account_id,from_addr,date,CASE WHEN json_valid(to_json) THEN to_json ELSE '[]' END AS to_json,CASE WHEN json_valid(cc_json) THEN cc_json ELSE '[]' END AS cc_json FROM messages m
      WHERE EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END) l WHERE l.value='SENT')
    )
    SELECT m.id,m.account_id,lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address'))),lower(trim(m.from_addr)),m.date FROM sent m,json_each(m.to_json) r WHERE trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address'))!=''
    UNION ALL
    SELECT m.id,m.account_id,lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address'))),lower(trim(m.from_addr)),m.date FROM sent m,json_each(m.cc_json) r WHERE trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address'))!='';
  CREATE TRIGGER sent_message_insert AFTER INSERT ON messages
    WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') BEGIN
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN json_valid(new.to_json) THEN new.to_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN json_valid(new.cc_json) THEN new.cc_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
  END;
  CREATE TRIGGER sent_message_update AFTER UPDATE OF account_id,from_addr,to_json,cc_json,date,labels_json ON messages
    WHEN old.account_id!=new.account_id OR old.from_addr!=new.from_addr OR old.to_json!=new.to_json OR old.cc_json!=new.cc_json OR old.date!=new.date OR old.labels_json!=new.labels_json BEGIN
    DELETE FROM sent_recipients WHERE message_id=new.id;
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') AND json_valid(new.to_json) THEN new.to_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') AND json_valid(new.cc_json) THEN new.cc_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
  END;`,
  // Migration 23: local signature library, durable draft recovery and indexed recipient candidates.
  `CREATE TABLE named_signatures (
    id TEXT PRIMARY KEY, address TEXT NOT NULL, name TEXT NOT NULL,
    text TEXT NOT NULL, html TEXT NOT NULL
  );
  CREATE INDEX named_signatures_address ON named_signatures(address);
  INSERT INTO named_signatures(id,address,name,text,html) SELECT 'legacy:'||address||':'||kind,address,CASE kind WHEN 'new' THEN 'New messages' ELSE 'Replies' END,text,'' FROM signatures WHERE source='local';
  -- Retained settings keep rowid for recovery's per-row salvage.
  CREATE TABLE signature_defaults (
    address TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('new','reply')), signature_id TEXT,
    PRIMARY KEY(address,kind)
  );
  INSERT INTO signature_defaults(address,kind,signature_id) SELECT address,kind,'legacy:'||address||':'||kind FROM signatures WHERE source='local';
  ALTER TABLE server_contacts ADD COLUMN contact_key TEXT NOT NULL DEFAULT '';
  CREATE INDEX server_contacts_key ON server_contacts(account_id,contact_key);
  ALTER TABLE send_as ADD COLUMN signature_html TEXT NOT NULL DEFAULT '';
  ALTER TABLE drafts ADD COLUMN sync_error TEXT;
  ALTER TABLE drafts ADD COLUMN local_only INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE contact_candidates (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    address TEXT NOT NULL, name TEXT NOT NULL, date INTEGER NOT NULL, weight REAL NOT NULL,
    source INTEGER NOT NULL
  );
  CREATE INDEX contact_candidates_address ON contact_candidates(address,source DESC,date DESC);
  CREATE INDEX contact_candidates_account ON contact_candidates(account_id);
  CREATE INDEX contact_candidates_message ON contact_candidates(message_id);
  CREATE VIRTUAL TABLE contact_candidates_fts USING fts5(name,address,content='contact_candidates',content_rowid='rowid');
  CREATE TRIGGER contact_candidates_ai AFTER INSERT ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(rowid,name,address) VALUES(new.rowid,new.name,new.address);
  END;
  CREATE TRIGGER contact_candidates_ad AFTER DELETE ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(contact_candidates_fts,rowid,name,address) VALUES('delete',old.rowid,old.name,old.address);
  END;
  CREATE TRIGGER contact_candidates_au AFTER UPDATE ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(contact_candidates_fts,rowid,name,address) VALUES('delete',old.rowid,old.name,old.address);
    INSERT INTO contact_candidates_fts(rowid,name,address) VALUES(new.rowid,new.name,new.address);
  END;
  INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
    SELECT 'server:'||account_id||':'||address,account_id,address,name,0,0.2,3 FROM server_contacts WHERE trim(address)!='';
  CREATE TRIGGER server_contact_candidate_ai AFTER INSERT ON server_contacts WHEN trim(new.address)!='' BEGIN
    INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'server:'||new.account_id||':'||new.address,new.account_id,new.address,new.name,0,0.2,3 WHERE trim(new.address)!='';
  END;
  CREATE TRIGGER server_contact_candidate_ad AFTER DELETE ON server_contacts BEGIN
    DELETE FROM contact_candidates WHERE id='server:'||old.account_id||':'||old.address;
  END;
  CREATE TRIGGER server_contact_candidate_au AFTER UPDATE ON server_contacts BEGIN
    DELETE FROM contact_candidates WHERE id='server:'||old.account_id||':'||old.address;
    INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'server:'||new.account_id||':'||new.address,new.account_id,new.address,new.name,0,0.2,3 WHERE trim(new.address)!='';
  END;
  -- sent_recipients owns sent history; candidates are its FTS projection, enriched with names.
  INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'sent:'||s.message_id||':'||s.address,s.account_id,s.message_id,s.address,
    COALESCE((SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),
      (SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),''),s.sent_at,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address) THEN 3.0 ELSE 2.0 END,2
    FROM sent_recipients s JOIN messages m ON m.id=s.message_id WHERE trim(s.address)!='';
  INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'from:'||m.id,m.account_id,m.id,lower(trim(m.from_addr)),m.from_name,m.date,1.0,1
    FROM messages m WHERE trim(m.from_addr)!='' AND NOT EXISTS(SELECT 1 FROM
      json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END)
      WHERE value IN ('SENT','SPAM','TRASH','DRAFT'));
  CREATE TRIGGER sent_contact_candidate_ai AFTER INSERT ON sent_recipients BEGIN
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'sent:'||s.message_id||':'||s.address,s.account_id,s.message_id,s.address,
    COALESCE((SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),
      (SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),''),s.sent_at,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address) THEN 3.0 ELSE 2.0 END,2
    FROM sent_recipients s JOIN messages m ON m.id=s.message_id WHERE trim(s.address)!='' AND s.message_id=new.message_id AND s.address=new.address;
  END;
  CREATE TRIGGER sent_contact_candidate_ad AFTER DELETE ON sent_recipients BEGIN
    DELETE FROM contact_candidates WHERE id='sent:'||old.message_id||':'||old.address;
  END;
  CREATE TRIGGER sent_contact_candidate_au AFTER UPDATE ON sent_recipients
    WHEN old.message_id!=new.message_id OR old.address!=new.address OR old.account_id!=new.account_id OR old.sent_at!=new.sent_at BEGIN
    DELETE FROM contact_candidates WHERE id='sent:'||old.message_id||':'||old.address;
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'sent:'||s.message_id||':'||s.address,s.account_id,s.message_id,s.address,
    COALESCE((SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),
      (SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),''),s.sent_at,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address) THEN 3.0 ELSE 2.0 END,2
    FROM sent_recipients s JOIN messages m ON m.id=s.message_id WHERE trim(s.address)!='' AND s.message_id=new.message_id AND s.address=new.address;
  END;
  CREATE TRIGGER message_contact_candidate_ai AFTER INSERT ON messages BEGIN
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'from:'||m.id,m.account_id,m.id,lower(trim(m.from_addr)),m.from_name,m.date,1.0,1
    FROM messages m WHERE trim(m.from_addr)!='' AND NOT EXISTS(SELECT 1 FROM
      json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END)
      WHERE value IN ('SENT','SPAM','TRASH','DRAFT')) AND m.id=new.id;
  END;
  CREATE TRIGGER message_contact_candidate_au AFTER UPDATE OF account_id,from_name,from_addr,to_json,cc_json,labels_json,date ON messages
    WHEN old.account_id!=new.account_id OR old.from_name!=new.from_name OR old.from_addr!=new.from_addr
      OR old.to_json!=new.to_json OR old.cc_json!=new.cc_json OR old.labels_json!=new.labels_json OR old.date!=new.date BEGIN
    DELETE FROM contact_candidates WHERE message_id=new.id AND source=1;
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'from:'||m.id,m.account_id,m.id,lower(trim(m.from_addr)),m.from_name,m.date,1.0,1
    FROM messages m WHERE trim(m.from_addr)!='' AND NOT EXISTS(SELECT 1 FROM
      json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END)
      WHERE value IN ('SENT','SPAM','TRASH','DRAFT')) AND m.id=new.id;
  END;`,
  // Migration 24: word search, stable message identity and per-account categories.
  `ALTER TABLE messages ADD COLUMN bcc_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;
   ALTER TABLE messages ADD COLUMN message_size INTEGER;
   CREATE INDEX messages_rfc_id ON messages(account_id,rfc_message_id);
   ALTER TABLE account_organization ADD COLUMN selected_categories TEXT;
   CREATE TABLE invite_responses (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, uid TEXT NOT NULL, organizer TEXT NOT NULL, recurrence_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(account_id,uid,organizer,recurrence_id));
   DROP TRIGGER messages_au;
   CREATE TRIGGER messages_au AFTER UPDATE OF subject,from_name,from_addr,body_text ON messages WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_addr IS NOT new.from_addr OR old.body_text IS NOT new.body_text BEGIN
    INSERT INTO messages_fts(messages_fts,rowid,subject,from_name,from_addr,body_text)
    VALUES ('delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text);
    INSERT INTO messages_fts(rowid,subject,from_name,from_addr,body_text)
    VALUES (new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
   END;
   DROP TRIGGER derived_au;
   CREATE TRIGGER derived_au AFTER UPDATE ON derived_chunks WHEN old.text IS NOT new.text BEGIN
    INSERT INTO derived_fts(derived_fts,rowid,text) VALUES('delete',old.id,old.text);
    INSERT INTO derived_fts(rowid,text) VALUES(new.id,new.text);
   END;
   CREATE TABLE search_word_index (kind TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, end_rowid INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE search_word_rows (kind TEXT NOT NULL, row_id INTEGER NOT NULL, PRIMARY KEY(kind,row_id));
   INSERT INTO search_word_index(kind,end_rowid,ready) SELECT 'messages',COALESCE(MAX(rowid),0),CASE WHEN MAX(rowid) IS NULL THEN 1 ELSE 0 END FROM messages;
   CREATE VIRTUAL TABLE messages_words USING fts5(subject,from_name,from_addr,body_text,content='messages',content_rowid='rowid',tokenize='unicode61');
   CREATE TRIGGER messages_words_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text) VALUES(new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
     INSERT INTO search_word_rows(kind,row_id) VALUES('messages',new.rowid);
   END;
   CREATE TRIGGER messages_words_ad AFTER DELETE ON messages WHEN EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid) BEGIN
     INSERT INTO messages_words(messages_words,rowid,subject,from_name,from_addr,body_text) VALUES('delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text);
     DELETE FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid;
   END;
   CREATE TRIGGER messages_words_au AFTER UPDATE OF subject,from_name,from_addr,body_text ON messages WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_addr IS NOT new.from_addr OR old.body_text IS NOT new.body_text BEGIN
     INSERT INTO messages_words(messages_words,rowid,subject,from_name,from_addr,body_text) SELECT 'delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text WHERE EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid);
     INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text) VALUES(new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
     INSERT INTO search_word_rows(kind,row_id) SELECT 'messages',new.rowid WHERE NOT EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=new.rowid);
   END;
   INSERT INTO search_word_index(kind,end_rowid,ready) SELECT 'derived',COALESCE(MAX(id),0),CASE WHEN MAX(id) IS NULL THEN 1 ELSE 0 END FROM derived_chunks;
   CREATE VIRTUAL TABLE derived_words USING fts5(text,content='derived_chunks',content_rowid='id',tokenize='unicode61');
   CREATE TRIGGER derived_words_ai AFTER INSERT ON derived_chunks BEGIN
     INSERT INTO derived_words(rowid,text) VALUES(new.id,new.text);
     INSERT INTO search_word_rows(kind,row_id) VALUES('derived',new.id);
   END;
   CREATE TRIGGER derived_words_ad AFTER DELETE ON derived_chunks WHEN EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=old.id) BEGIN
     INSERT INTO derived_words(derived_words,rowid,text) VALUES('delete',old.id,old.text);
     DELETE FROM search_word_rows WHERE kind='derived' AND row_id=old.id;
   END;
   CREATE TRIGGER derived_words_au AFTER UPDATE OF text ON derived_chunks WHEN old.text IS NOT new.text BEGIN
     INSERT INTO derived_words(derived_words,rowid,text) SELECT 'delete',old.id,old.text WHERE EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=old.id);
     INSERT INTO derived_words(rowid,text) VALUES(new.id,new.text);
     INSERT INTO search_word_rows(kind,row_id) SELECT 'derived',new.id WHERE NOT EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=new.id);
   END;`,
  // Migration 25: organizational undo only. Never persist bodies or credentials.
  `CREATE TABLE undo_batches (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
  );`,
  // 26: third-party AI consent is absent/false for every existing and new account.
  `CREATE TABLE ai_accounts(account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    allowed INTEGER NOT NULL DEFAULT 0, auto_summaries INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE ai_config(id INTEGER PRIMARY KEY CHECK(id=1),model TEXT NOT NULL);
   CREATE TABLE derived(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,kind TEXT NOT NULL,model TEXT NOT NULL,prompt_version TEXT NOT NULL,
    input_hash TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(thread_id,kind));
   CREATE TRIGGER ai_derived_update AFTER UPDATE OF body_text,subject,from_addr,to_json,cc_json,date ON messages WHEN old.body_text IS NOT new.body_text OR old.subject IS NOT new.subject OR old.from_addr IS NOT new.from_addr OR old.to_json IS NOT new.to_json OR old.cc_json IS NOT new.cc_json OR old.date IS NOT new.date BEGIN
     DELETE FROM derived WHERE account_id=old.account_id AND thread_id=old.account_id || '/' || old.thread_id;
   END;
   CREATE TRIGGER ai_derived_delete AFTER DELETE ON messages BEGIN
     DELETE FROM derived WHERE account_id=old.account_id AND thread_id=old.account_id || '/' || old.thread_id;
   END;`,
  // Migration 27: parsed invitation cache, independent of media extraction and preferences.
  `CREATE TABLE calendar_invites (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    invite_key TEXT NOT NULL, account_id TEXT NOT NULL, uid TEXT NOT NULL,
    sequence INTEGER NOT NULL, message_date INTEGER NOT NULL, invite_json TEXT NOT NULL,
    PRIMARY KEY(message_id,invite_key)
  );
  CREATE INDEX calendar_invites_uid ON calendar_invites(account_id,uid,sequence DESC,message_date DESC);
  CREATE TRIGGER calendar_invites_changed AFTER UPDATE OF body_text,body_html,attachments_json ON messages
    WHEN old.body_text IS NOT new.body_text OR old.body_html IS NOT new.body_html OR old.attachments_json IS NOT new.attachments_json BEGIN
      DELETE FROM calendar_invites WHERE message_id=new.id;
  END;`,
  // 28: organization metadata for provider contact completion. No message-index rebuild.
  `CREATE TABLE contact_organizations (
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, company TEXT NOT NULL, PRIMARY KEY(account_id,address)
  );
  CREATE VIRTUAL TABLE contact_organizations_fts USING fts5(company,content='contact_organizations',content_rowid='rowid',tokenize='unicode61');
  CREATE TRIGGER contact_organizations_ai AFTER INSERT ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(rowid,company) VALUES(new.rowid,new.company);
  END;
  CREATE TRIGGER contact_organizations_ad AFTER DELETE ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(contact_organizations_fts,rowid,company) VALUES('delete',old.rowid,old.company);
  END;
  CREATE TRIGGER contact_organizations_au AFTER UPDATE ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(contact_organizations_fts,rowid,company) VALUES('delete',old.rowid,old.company);
    INSERT INTO contact_organizations_fts(rowid,company) VALUES(new.rowid,new.company);
  END;`,
  // Migration 29: triage consent is independent of automatic summaries.
  `ALTER TABLE ai_accounts ADD COLUMN auto_triage INTEGER NOT NULL DEFAULT 0;`,
  // Migration 30: covering indexes keep list statistics away from cached bodies.
  `CREATE INDEX messages_thread_labels ON messages(account_id,thread_id,labels_json);
   DROP INDEX messages_account_thread;
   CREATE INDEX messages_unread_threads ON messages(account_id,thread_id,labels_json) WHERE is_unread=1;
   CREATE INDEX messages_badge_threads ON messages(account_id,thread_id,is_unread,labels_json)
     WHERE is_unread=1 OR labels_json LIKE '%"STARRED"%' OR labels_json LIKE '%"DRAFT"%';
   CREATE INDEX messages_provider ON messages(account_id,provider_id);
   CREATE INDEX messages_rfc_trimmed ON messages(account_id,trim(rfc_message_id,'<>'),date DESC);
   DROP INDEX messages_rfc_id;
   CREATE INDEX messages_cache_page ON messages(account_id,body_cached,date,id,body_opened_at);
   DROP INDEX messages_cache_date;
   CREATE INDEX contact_candidates_score ON contact_candidates(address,source DESC,date DESC,account_id,id,name,weight);
   CREATE INDEX contact_candidates_company ON contact_candidates(address,account_id);
   -- A single FTS document preserves mixed name/address/company conjunctions.
   CREATE VIRTUAL TABLE contact_completion_fts USING fts5(address,name,company,
     content='',contentless_delete=1,tokenize='unicode61',prefix='1 2 3');
   INSERT INTO contact_completion_fts(rowid,address,name,company)
     SELECT c.rowid,c.address,c.name,COALESCE((SELECT company FROM contact_organizations o
       WHERE o.account_id=c.account_id AND o.address=c.address),'') FROM contact_candidates c;
   CREATE TRIGGER contact_completion_ai AFTER INSERT ON contact_candidates BEGIN
     INSERT INTO contact_completion_fts(rowid,address,name,company) VALUES(new.rowid,new.address,new.name,
       COALESCE((SELECT company FROM contact_organizations WHERE account_id=new.account_id AND address=new.address),''));
   END;
   CREATE TRIGGER contact_completion_ad AFTER DELETE ON contact_candidates BEGIN
     DELETE FROM contact_completion_fts WHERE rowid=old.rowid;
   END;
   CREATE TRIGGER contact_completion_au AFTER UPDATE OF address,name,account_id ON contact_candidates
     WHEN old.address IS NOT new.address OR old.name IS NOT new.name OR old.account_id IS NOT new.account_id BEGIN
     DELETE FROM contact_completion_fts WHERE rowid=old.rowid;
     INSERT INTO contact_completion_fts(rowid,address,name,company) VALUES(new.rowid,new.address,new.name,
       COALESCE((SELECT company FROM contact_organizations WHERE account_id=new.account_id AND address=new.address),''));
   END;
   CREATE TRIGGER contact_completion_org_ai AFTER INSERT ON contact_organizations BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE account_id=new.account_id AND address=new.address);
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT rowid,address,name,new.company FROM contact_candidates WHERE account_id=new.account_id AND address=new.address;
   END;
   CREATE TRIGGER contact_completion_org_ad AFTER DELETE ON contact_organizations BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE account_id=old.account_id AND address=old.address);
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT rowid,address,name,'' FROM contact_candidates WHERE account_id=old.account_id AND address=old.address;
   END;
   CREATE TRIGGER contact_completion_org_au AFTER UPDATE ON contact_organizations
     WHEN old.company IS NOT new.company OR old.account_id IS NOT new.account_id OR old.address IS NOT new.address BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE (account_id=old.account_id AND address=old.address) OR (account_id=new.account_id AND address=new.address));
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT c.rowid,c.address,c.name,
       COALESCE((SELECT company FROM contact_organizations o WHERE o.account_id=c.account_id AND o.address=c.address),'') FROM contact_candidates c WHERE (c.account_id=old.account_id AND c.address=old.address) OR (c.account_id=new.account_id AND c.address=new.address);
   END;
   DROP INDEX contact_candidates_address;
   CREATE INDEX pending_ops_account ON pending_ops(account_id,provider_id);
   -- Only counted badge memberships are projected. The key orders each
   -- label/account's conversations so DISTINCT does not sort message bodies.
   CREATE TABLE message_badges (
     label TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
     message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     in_inbox INTEGER NOT NULL,
     PRIMARY KEY(label,account_id,thread_id,message_id)
   ) WITHOUT ROWID;
   CREATE INDEX message_badges_message ON message_badges(message_id);
   INSERT INTO message_badges SELECT l.value,m.account_id,m.thread_id,m.id,
       EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value='INBOX')
     FROM messages m,json_each(m.labels_json) l
     WHERE (m.is_unread=1 OR m.labels_json LIKE '%"STARRED"%' OR m.labels_json LIKE '%"DRAFT"%')
       AND (m.is_unread=1 OR l.value IN ('STARRED','DRAFT')) GROUP BY m.id,l.value;
   -- This covering index only accelerates the one-time projection backfill.
   DROP INDEX messages_badge_threads;
   CREATE TRIGGER message_badges_ai AFTER INSERT ON messages BEGIN
     INSERT INTO message_badges SELECT DISTINCT l.value,new.account_id,new.thread_id,new.id,
       EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value='INBOX')
       FROM json_each(new.labels_json) l WHERE new.is_unread=1 OR l.value IN ('STARRED','DRAFT');
   END;
   CREATE TRIGGER message_badges_au AFTER UPDATE OF account_id,thread_id,labels_json,is_unread ON messages
     WHEN old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id
       OR old.labels_json IS NOT new.labels_json OR old.is_unread IS NOT new.is_unread BEGIN
     DELETE FROM message_badges WHERE message_id=new.id;
     INSERT INTO message_badges SELECT DISTINCT l.value,new.account_id,new.thread_id,new.id,
       EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value='INBOX')
       FROM json_each(new.labels_json) l WHERE new.is_unread=1 OR l.value IN ('STARRED','DRAFT');
   END;
   -- One compact row per message keeps broad FTS counts away from MIME bodies.
   CREATE TABLE message_search_meta (
     row_id INTEGER PRIMARY KEY,
     message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
     account_id TEXT NOT NULL, thread_id TEXT NOT NULL, eligible INTEGER NOT NULL
   );
   CREATE INDEX message_search_meta_threads ON message_search_meta(account_id,thread_id,eligible,row_id);
   INSERT INTO message_search_meta SELECT m.rowid,m.id,m.account_id,m.thread_id,
     NOT EXISTS(SELECT 1 FROM json_each(m.labels_json) WHERE value IN ('SPAM','TRASH')) FROM messages m;
   CREATE TRIGGER message_search_meta_ai AFTER INSERT ON messages BEGIN
     INSERT INTO message_search_meta VALUES(new.rowid,new.id,new.account_id,new.thread_id,
       NOT EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value IN ('SPAM','TRASH')));
   END;
   CREATE TRIGGER message_search_meta_au AFTER UPDATE OF account_id,thread_id,labels_json ON messages
     WHEN old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id OR old.labels_json IS NOT new.labels_json BEGIN
     UPDATE message_search_meta SET account_id=new.account_id,thread_id=new.thread_id,
       eligible=NOT EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value IN ('SPAM','TRASH')) WHERE row_id=new.rowid;
   END;`,
  // 31: Cached headers and word positions for local Gmail search operators.
  `ALTER TABLE messages ADD COLUMN headers_json TEXT;
   CREATE VIRTUAL TABLE messages_word_positions USING fts5vocab(messages_words, 'instance');
   CREATE VIRTUAL TABLE derived_word_positions USING fts5vocab(derived_words, 'instance');`,
  // Migration 32: provider authentication results and safe list-unsubscribe target.
  `ALTER TABLE messages ADD COLUMN security_json TEXT;`,
  // Migration 33: local optional-service switches, never credentials.
  `CREATE TABLE account_optional_services (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    disabled_json TEXT NOT NULL DEFAULT '[]'
  );`,
  // Migration 34: body sizes, a running byte total and hourly budget maintenance.
  `ALTER TABLE messages ADD COLUMN body_bytes INTEGER NOT NULL DEFAULT 0;
   UPDATE messages SET body_bytes=length(CAST(body_text AS BLOB))+length(CAST(body_html AS BLOB));
   CREATE TABLE body_cache_budget (id INTEGER PRIMARY KEY CHECK(id=1), total_bytes INTEGER NOT NULL, evicted_at INTEGER);
   INSERT INTO body_cache_budget SELECT 1, COALESCE(SUM(body_bytes),0), NULL FROM messages;
   CREATE INDEX messages_body_lru ON messages(COALESCE(body_opened_at,date),id) WHERE body_cached=1 AND body_bytes>0;
   CREATE TRIGGER messages_body_bytes_ai AFTER INSERT ON messages BEGIN
     UPDATE messages SET body_bytes=length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=new.id;
     UPDATE body_cache_budget SET total_bytes=total_bytes+length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=1;
   END;
   CREATE TRIGGER messages_body_bytes_au AFTER UPDATE OF body_text,body_html ON messages WHEN old.body_text IS NOT new.body_text OR old.body_html IS NOT new.body_html BEGIN
     UPDATE messages SET body_bytes=length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=new.id;
     UPDATE body_cache_budget SET total_bytes=total_bytes+length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB))-old.body_bytes WHERE id=1;
   END;
   CREATE TRIGGER messages_body_bytes_ad AFTER DELETE ON messages BEGIN
     UPDATE body_cache_budget SET total_bytes=total_bytes-old.body_bytes WHERE id=1;
   END;`,
  // Migration 35: sync diagnostics, bounded stale pages and body-size reporting.
  `DROP INDEX messages_provider;
   CREATE INDEX messages_provider ON messages(account_id,provider_id,date DESC,id);
   CREATE INDEX messages_imap_scope ON messages(account_id,
     substr(provider_id, instr(provider_id, ':') + instr(substr(provider_id, instr(provider_id, ':') + 1), ':') + 1),
     provider_id,date);
   CREATE INDEX drafts_stale_ids ON drafts(account_id,remote_message_id) WHERE remote_message_id IS NOT NULL AND local_only=0 AND sync_error IS NULL;
   CREATE INDEX messages_body_sizes ON messages(account_id,body_bytes);
   DROP INDEX messages_list_date_id;
   CREATE INDEX messages_list_date_id ON messages(list_date DESC,id DESC,account_id,thread_id,is_unread,is_starred,labels_json);`,
  // Migration 36: durable outbound retries, fenced leases and user-visible failures.
  `ALTER TABLE pending_ops ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pending_ops ADD COLUMN claim_token TEXT;
   ALTER TABLE pending_ops ADD COLUMN rfc_message_id TEXT;
   ALTER TABLE pending_ops ADD COLUMN progress_json TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE pending_ops ADD COLUMN appended_message_id TEXT;
   UPDATE pending_ops SET rfc_message_id=(SELECT rfc_message_id FROM messages WHERE messages.account_id=pending_ops.account_id AND messages.provider_id=pending_ops.provider_id ORDER BY date DESC LIMIT 1);
   CREATE TABLE failed_ops (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     provider_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
     subject TEXT, sender TEXT, rejected_json TEXT NOT NULL DEFAULT '[]'
   );`,
  // Migration 37: pin external-content FTS rowids before user-requested VACUUM.
  `DROP TRIGGER ai_derived_delete;
DROP TRIGGER ai_derived_update;
DROP TRIGGER calendar_invites_changed;
DROP TRIGGER contact_candidates_ad;
DROP TRIGGER contact_candidates_ai;
DROP TRIGGER contact_candidates_au;
DROP TRIGGER contact_completion_ad;
DROP TRIGGER contact_completion_ai;
DROP TRIGGER contact_completion_au;
DROP TRIGGER contact_completion_org_ad;
DROP TRIGGER contact_completion_org_ai;
DROP TRIGGER contact_completion_org_au;
DROP TRIGGER contact_organizations_ad;
DROP TRIGGER contact_organizations_ai;
DROP TRIGGER contact_organizations_au;
DROP TRIGGER derived_ad;
DROP TRIGGER derived_ai;
DROP TRIGGER derived_au;
DROP TRIGGER derived_priority_insert;
DROP TRIGGER derived_words_ad;
DROP TRIGGER derived_words_ai;
DROP TRIGGER derived_words_au;
DROP TRIGGER media_message_insert;
DROP TRIGGER media_message_update;
DROP TRIGGER message_badges_ai;
DROP TRIGGER message_badges_au;
DROP TRIGGER message_contact_candidate_ai;
DROP TRIGGER message_contact_candidate_au;
DROP TRIGGER message_priority_update;
DROP TRIGGER message_search_meta_ai;
DROP TRIGGER message_search_meta_au;
DROP TRIGGER messages_ad;
DROP TRIGGER messages_ai;
DROP TRIGGER messages_au;
DROP TRIGGER messages_body_bytes_ad;
DROP TRIGGER messages_body_bytes_ai;
DROP TRIGGER messages_body_bytes_au;
DROP TRIGGER messages_words_ad;
DROP TRIGGER messages_words_ai;
DROP TRIGGER messages_words_au;
DROP TRIGGER reminders_list_date;
DROP TRIGGER semantic_media_insert;
DROP TRIGGER semantic_message_insert;
DROP TRIGGER semantic_message_update;
DROP TRIGGER semantic_priority_insert;
DROP TRIGGER sent_contact_candidate_ad;
DROP TRIGGER sent_contact_candidate_ai;
DROP TRIGGER sent_contact_candidate_au;
DROP TRIGGER sent_message_insert;
DROP TRIGGER sent_message_update;
DROP TRIGGER server_contact_candidate_ad;
DROP TRIGGER server_contact_candidate_ai;
DROP TRIGGER server_contact_candidate_au;
DROP TRIGGER snoozed_list_date_delete;
DROP TRIGGER snoozed_list_date_insert;
CREATE TABLE cache_new_messages (rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
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
  , calendar_hint INTEGER, body_cached INTEGER NOT NULL DEFAULT 1, list_date INTEGER NOT NULL DEFAULT 0, body_opened_at INTEGER, reply_to_json TEXT, web_link TEXT, bcc_json TEXT NOT NULL DEFAULT '[]', rfc_message_id TEXT, message_size INTEGER, headers_json TEXT, security_json TEXT, body_bytes INTEGER NOT NULL DEFAULT 0);
INSERT INTO cache_new_messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,calendar_hint,body_cached,list_date,body_opened_at,reply_to_json,web_link,bcc_json,rfc_message_id,message_size,headers_json,security_json,body_bytes) SELECT rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,calendar_hint,body_cached,list_date,body_opened_at,reply_to_json,web_link,bcc_json,rfc_message_id,message_size,headers_json,security_json,body_bytes FROM messages;
DROP TABLE messages;
ALTER TABLE cache_new_messages RENAME TO messages;
CREATE INDEX messages_account_date ON messages(account_id, date DESC);
CREATE INDEX messages_date ON messages(date DESC);
CREATE INDEX messages_thread ON messages(thread_id);
CREATE INDEX messages_account_list_date_id ON messages(account_id, list_date DESC, id DESC);
CREATE INDEX messages_thread_list_date_id ON messages(account_id, thread_id, list_date DESC, id DESC);
CREATE INDEX messages_thread_labels ON messages(account_id,thread_id,labels_json);
CREATE INDEX messages_unread_threads ON messages(account_id,thread_id,labels_json) WHERE is_unread=1;
CREATE INDEX messages_rfc_trimmed ON messages(account_id,trim(rfc_message_id,'<>'),date DESC);
CREATE INDEX messages_cache_page ON messages(account_id,body_cached,date,id,body_opened_at);
CREATE INDEX messages_body_lru ON messages(COALESCE(body_opened_at,date),id) WHERE body_cached=1 AND body_bytes>0;
CREATE INDEX messages_provider ON messages(account_id,provider_id,date DESC,id);
CREATE INDEX messages_imap_scope ON messages(account_id,
     substr(provider_id, instr(provider_id, ':') + instr(substr(provider_id, instr(provider_id, ':') + 1), ':') + 1),
     provider_id,date);
CREATE INDEX messages_body_sizes ON messages(account_id,body_bytes);
CREATE INDEX messages_list_date_id ON messages(list_date DESC,id DESC,account_id,thread_id,is_unread,is_starred,labels_json);
CREATE TABLE cache_new_contact_candidates (rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    address TEXT NOT NULL, name TEXT NOT NULL, date INTEGER NOT NULL, weight REAL NOT NULL,
    source INTEGER NOT NULL
  );
INSERT INTO cache_new_contact_candidates(rowid,id,account_id,message_id,address,name,date,weight,source) SELECT rowid,id,account_id,message_id,address,name,date,weight,source FROM contact_candidates;
DROP TABLE contact_candidates;
ALTER TABLE cache_new_contact_candidates RENAME TO contact_candidates;
CREATE INDEX contact_candidates_account ON contact_candidates(account_id);
CREATE INDEX contact_candidates_message ON contact_candidates(message_id);
CREATE INDEX contact_candidates_score ON contact_candidates(address,source DESC,date DESC,account_id,id,name,weight);
CREATE INDEX contact_candidates_company ON contact_candidates(address,account_id);
CREATE TABLE cache_new_contact_organizations (rowid INTEGER PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    address TEXT NOT NULL, company TEXT NOT NULL, UNIQUE(account_id,address)
  );
INSERT INTO cache_new_contact_organizations(rowid,account_id,address,company) SELECT rowid,account_id,address,company FROM contact_organizations;
DROP TABLE contact_organizations;
ALTER TABLE cache_new_contact_organizations RENAME TO contact_organizations;

CREATE TRIGGER ai_derived_delete AFTER DELETE ON messages BEGIN
     DELETE FROM derived WHERE account_id=old.account_id AND thread_id=old.account_id || '/' || old.thread_id;
   END;
CREATE TRIGGER ai_derived_update AFTER UPDATE OF body_text,subject,from_addr,to_json,cc_json,date ON messages WHEN old.body_text IS NOT new.body_text OR old.subject IS NOT new.subject OR old.from_addr IS NOT new.from_addr OR old.to_json IS NOT new.to_json OR old.cc_json IS NOT new.cc_json OR old.date IS NOT new.date BEGIN
     DELETE FROM derived WHERE account_id=old.account_id AND thread_id=old.account_id || '/' || old.thread_id;
   END;
CREATE TRIGGER calendar_invites_changed AFTER UPDATE OF body_text,body_html,attachments_json ON messages
    WHEN old.body_text IS NOT new.body_text OR old.body_html IS NOT new.body_html OR old.attachments_json IS NOT new.attachments_json BEGIN
      DELETE FROM calendar_invites WHERE message_id=new.id;
  END;
CREATE TRIGGER contact_candidates_ad AFTER DELETE ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(contact_candidates_fts,rowid,name,address) VALUES('delete',old.rowid,old.name,old.address);
  END;
CREATE TRIGGER contact_candidates_ai AFTER INSERT ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(rowid,name,address) VALUES(new.rowid,new.name,new.address);
  END;
CREATE TRIGGER contact_candidates_au AFTER UPDATE ON contact_candidates BEGIN
    INSERT INTO contact_candidates_fts(contact_candidates_fts,rowid,name,address) VALUES('delete',old.rowid,old.name,old.address);
    INSERT INTO contact_candidates_fts(rowid,name,address) VALUES(new.rowid,new.name,new.address);
  END;
CREATE TRIGGER contact_completion_ad AFTER DELETE ON contact_candidates BEGIN
     DELETE FROM contact_completion_fts WHERE rowid=old.rowid;
   END;
CREATE TRIGGER contact_completion_ai AFTER INSERT ON contact_candidates BEGIN
     INSERT INTO contact_completion_fts(rowid,address,name,company) VALUES(new.rowid,new.address,new.name,
       COALESCE((SELECT company FROM contact_organizations WHERE account_id=new.account_id AND address=new.address),''));
   END;
CREATE TRIGGER contact_completion_au AFTER UPDATE OF address,name,account_id ON contact_candidates
     WHEN old.address IS NOT new.address OR old.name IS NOT new.name OR old.account_id IS NOT new.account_id BEGIN
     DELETE FROM contact_completion_fts WHERE rowid=old.rowid;
     INSERT INTO contact_completion_fts(rowid,address,name,company) VALUES(new.rowid,new.address,new.name,
       COALESCE((SELECT company FROM contact_organizations WHERE account_id=new.account_id AND address=new.address),''));
   END;
CREATE TRIGGER contact_completion_org_ad AFTER DELETE ON contact_organizations BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE account_id=old.account_id AND address=old.address);
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT rowid,address,name,'' FROM contact_candidates WHERE account_id=old.account_id AND address=old.address;
   END;
CREATE TRIGGER contact_completion_org_ai AFTER INSERT ON contact_organizations BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE account_id=new.account_id AND address=new.address);
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT rowid,address,name,new.company FROM contact_candidates WHERE account_id=new.account_id AND address=new.address;
   END;
CREATE TRIGGER contact_completion_org_au AFTER UPDATE ON contact_organizations
     WHEN old.company IS NOT new.company OR old.account_id IS NOT new.account_id OR old.address IS NOT new.address BEGIN
     DELETE FROM contact_completion_fts WHERE rowid IN (SELECT rowid FROM contact_candidates WHERE (account_id=old.account_id AND address=old.address) OR (account_id=new.account_id AND address=new.address));
     INSERT INTO contact_completion_fts(rowid,address,name,company) SELECT c.rowid,c.address,c.name,
       COALESCE((SELECT company FROM contact_organizations o WHERE o.account_id=c.account_id AND o.address=c.address),'') FROM contact_candidates c WHERE (c.account_id=old.account_id AND c.address=old.address) OR (c.account_id=new.account_id AND c.address=new.address);
   END;
CREATE TRIGGER contact_organizations_ad AFTER DELETE ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(contact_organizations_fts,rowid,company) VALUES('delete',old.rowid,old.company);
  END;
CREATE TRIGGER contact_organizations_ai AFTER INSERT ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(rowid,company) VALUES(new.rowid,new.company);
  END;
CREATE TRIGGER contact_organizations_au AFTER UPDATE ON contact_organizations BEGIN
    INSERT INTO contact_organizations_fts(contact_organizations_fts,rowid,company) VALUES('delete',old.rowid,old.company);
    INSERT INTO contact_organizations_fts(rowid,company) VALUES(new.rowid,new.company);
  END;
CREATE TRIGGER derived_ad AFTER DELETE ON derived_chunks BEGIN
    INSERT INTO derived_fts(derived_fts,rowid,text) VALUES('delete',old.id,old.text);
  END;
CREATE TRIGGER derived_ai AFTER INSERT ON derived_chunks BEGIN
    INSERT INTO derived_fts(rowid,text) VALUES(new.id,new.text);
  END;
CREATE TRIGGER derived_au AFTER UPDATE ON derived_chunks WHEN old.text IS NOT new.text BEGIN
    INSERT INTO derived_fts(derived_fts,rowid,text) VALUES('delete',old.id,old.text);
    INSERT INTO derived_fts(rowid,text) VALUES(new.id,new.text);
   END;
CREATE TRIGGER derived_priority_insert AFTER INSERT ON derived_jobs BEGIN
    UPDATE derived_jobs SET priority_at=(SELECT date FROM messages WHERE id=new.message_id) WHERE message_id=new.message_id;
  END;
CREATE TRIGGER derived_words_ad AFTER DELETE ON derived_chunks WHEN EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=old.id) BEGIN
     INSERT INTO derived_words(derived_words,rowid,text) VALUES('delete',old.id,old.text);
     DELETE FROM search_word_rows WHERE kind='derived' AND row_id=old.id;
   END;
CREATE TRIGGER derived_words_ai AFTER INSERT ON derived_chunks BEGIN
     INSERT INTO derived_words(rowid,text) VALUES(new.id,new.text);
     INSERT INTO search_word_rows(kind,row_id) VALUES('derived',new.id);
   END;
CREATE TRIGGER derived_words_au AFTER UPDATE OF text ON derived_chunks WHEN old.text IS NOT new.text BEGIN
     INSERT INTO derived_words(derived_words,rowid,text) SELECT 'delete',old.id,old.text WHERE EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=old.id);
     INSERT INTO derived_words(rowid,text) VALUES(new.id,new.text);
     INSERT INTO search_word_rows(kind,row_id) SELECT 'derived',new.id WHERE NOT EXISTS(SELECT 1 FROM search_word_rows WHERE kind='derived' AND row_id=new.id);
   END;
CREATE TRIGGER media_message_insert AFTER INSERT ON messages
    WHEN new.body_html LIKE '%cid:%' OR EXISTS(SELECT 1 FROM json_each(new.attachments_json)
      WHERE lower(json_extract(value,'$.mimeType')) LIKE 'image/%'
        OR lower(json_extract(value,'$.mimeType'))='application/pdf') BEGIN
    INSERT INTO derived_jobs(message_id) VALUES(new.id);
  END;
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
CREATE TRIGGER message_badges_ai AFTER INSERT ON messages BEGIN
     INSERT INTO message_badges SELECT DISTINCT l.value,new.account_id,new.thread_id,new.id,
       EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value='INBOX')
       FROM json_each(new.labels_json) l WHERE new.is_unread=1 OR l.value IN ('STARRED','DRAFT');
   END;
CREATE TRIGGER message_badges_au AFTER UPDATE OF account_id,thread_id,labels_json,is_unread ON messages
     WHEN old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id
       OR old.labels_json IS NOT new.labels_json OR old.is_unread IS NOT new.is_unread BEGIN
     DELETE FROM message_badges WHERE message_id=new.id;
     INSERT INTO message_badges SELECT DISTINCT l.value,new.account_id,new.thread_id,new.id,
       EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value='INBOX')
       FROM json_each(new.labels_json) l WHERE new.is_unread=1 OR l.value IN ('STARRED','DRAFT');
   END;
CREATE TRIGGER message_contact_candidate_ai AFTER INSERT ON messages BEGIN
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'from:'||m.id,m.account_id,m.id,lower(trim(m.from_addr)),m.from_name,m.date,1.0,1
    FROM messages m WHERE trim(m.from_addr)!='' AND NOT EXISTS(SELECT 1 FROM
      json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END)
      WHERE value IN ('SENT','SPAM','TRASH','DRAFT')) AND m.id=new.id;
  END;
CREATE TRIGGER message_contact_candidate_au AFTER UPDATE OF account_id,from_name,from_addr,to_json,cc_json,labels_json,date ON messages
    WHEN old.account_id!=new.account_id OR old.from_name!=new.from_name OR old.from_addr!=new.from_addr
      OR old.to_json!=new.to_json OR old.cc_json!=new.cc_json OR old.labels_json!=new.labels_json OR old.date!=new.date BEGIN
    DELETE FROM contact_candidates WHERE message_id=new.id AND source=1;
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'from:'||m.id,m.account_id,m.id,lower(trim(m.from_addr)),m.from_name,m.date,1.0,1
    FROM messages m WHERE trim(m.from_addr)!='' AND NOT EXISTS(SELECT 1 FROM
      json_each(CASE WHEN json_valid(m.labels_json) THEN m.labels_json ELSE '[]' END)
      WHERE value IN ('SENT','SPAM','TRASH','DRAFT')) AND m.id=new.id;
  END;
CREATE TRIGGER message_priority_update AFTER UPDATE OF date ON messages WHEN old.date!=new.date BEGIN
    UPDATE derived_jobs SET priority_at=new.date WHERE message_id=new.id;
    UPDATE semantic_jobs SET priority_at=new.date WHERE message_id=new.id;
  END;
CREATE TRIGGER message_search_meta_ai AFTER INSERT ON messages BEGIN
     INSERT INTO message_search_meta VALUES(new.rowid,new.id,new.account_id,new.thread_id,
       NOT EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value IN ('SPAM','TRASH')));
   END;
CREATE TRIGGER message_search_meta_au AFTER UPDATE OF account_id,thread_id,labels_json ON messages
     WHEN old.account_id IS NOT new.account_id OR old.thread_id IS NOT new.thread_id OR old.labels_json IS NOT new.labels_json BEGIN
     UPDATE message_search_meta SET account_id=new.account_id,thread_id=new.thread_id,
       eligible=NOT EXISTS(SELECT 1 FROM json_each(new.labels_json) WHERE value IN ('SPAM','TRASH')) WHERE row_id=new.rowid;
   END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, subject, from_name, from_addr, body_text)
    VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_addr, old.body_text);
  END;
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, subject, from_name, from_addr, body_text)
    VALUES (new.rowid, new.subject, new.from_name, new.from_addr, new.body_text);
  END;
CREATE TRIGGER messages_au AFTER UPDATE OF subject,from_name,from_addr,body_text ON messages WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_addr IS NOT new.from_addr OR old.body_text IS NOT new.body_text BEGIN
    INSERT INTO messages_fts(messages_fts,rowid,subject,from_name,from_addr,body_text)
    VALUES ('delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text);
    INSERT INTO messages_fts(rowid,subject,from_name,from_addr,body_text)
    VALUES (new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
   END;
CREATE TRIGGER messages_body_bytes_ad AFTER DELETE ON messages BEGIN
     UPDATE body_cache_budget SET total_bytes=total_bytes-old.body_bytes WHERE id=1;
   END;
CREATE TRIGGER messages_body_bytes_ai AFTER INSERT ON messages BEGIN
     UPDATE messages SET body_bytes=length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=new.id;
     UPDATE body_cache_budget SET total_bytes=total_bytes+length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=1;
   END;
CREATE TRIGGER messages_body_bytes_au AFTER UPDATE OF body_text,body_html ON messages WHEN old.body_text IS NOT new.body_text OR old.body_html IS NOT new.body_html BEGIN
     UPDATE messages SET body_bytes=length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB)) WHERE id=new.id;
     UPDATE body_cache_budget SET total_bytes=total_bytes+length(CAST(new.body_text AS BLOB))+length(CAST(new.body_html AS BLOB))-old.body_bytes WHERE id=1;
   END;
CREATE TRIGGER messages_words_ad AFTER DELETE ON messages WHEN EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid) BEGIN
     INSERT INTO messages_words(messages_words,rowid,subject,from_name,from_addr,body_text) VALUES('delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text);
     DELETE FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid;
   END;
CREATE TRIGGER messages_words_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text) VALUES(new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
     INSERT INTO search_word_rows(kind,row_id) VALUES('messages',new.rowid);
   END;
CREATE TRIGGER messages_words_au AFTER UPDATE OF subject,from_name,from_addr,body_text ON messages WHEN old.subject IS NOT new.subject OR old.from_name IS NOT new.from_name OR old.from_addr IS NOT new.from_addr OR old.body_text IS NOT new.body_text BEGIN
     INSERT INTO messages_words(messages_words,rowid,subject,from_name,from_addr,body_text) SELECT 'delete',old.rowid,old.subject,old.from_name,old.from_addr,old.body_text WHERE EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=old.rowid);
     INSERT INTO messages_words(rowid,subject,from_name,from_addr,body_text) VALUES(new.rowid,new.subject,new.from_name,new.from_addr,new.body_text);
     INSERT INTO search_word_rows(kind,row_id) SELECT 'messages',new.rowid WHERE NOT EXISTS(SELECT 1 FROM search_word_rows WHERE kind='messages' AND row_id=new.rowid);
   END;
CREATE TRIGGER reminders_list_date AFTER UPDATE OF woken_at ON thread_reminders BEGIN
    UPDATE messages SET list_date=MAX(date,COALESCE(new.woken_at,0))
    WHERE account_id=new.account_id AND thread_id=new.thread_id
      AND EXISTS (SELECT 1 FROM snoozed_messages s WHERE s.account_id=messages.account_id AND s.provider_id=messages.provider_id);
  END;
CREATE TRIGGER semantic_media_insert AFTER INSERT ON derived_chunks BEGIN
    INSERT INTO semantic_jobs(message_id) VALUES(new.message_id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',claim=NULL,
      claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
CREATE TRIGGER semantic_message_insert AFTER INSERT ON messages BEGIN
    INSERT INTO semantic_jobs(message_id) VALUES(new.id);
  END;
CREATE TRIGGER semantic_message_update AFTER UPDATE OF body_text,body_html,attachments_json ON messages
    WHEN (old.body_text != new.body_text OR old.body_html != new.body_html OR old.attachments_json != new.attachments_json)
      AND old.body_cached = new.body_cached BEGIN
    DELETE FROM vector_items WHERE message_id=new.id;
    INSERT INTO semantic_jobs(message_id) VALUES(new.id)
      ON CONFLICT(message_id) DO UPDATE SET generation=generation+1,status='queued',claim=NULL,
      claimed_at=NULL,attempts=0,retry_at=0,note=NULL;
  END;
CREATE TRIGGER semantic_priority_insert AFTER INSERT ON semantic_jobs BEGIN
    UPDATE semantic_jobs SET priority_at=(SELECT date FROM messages WHERE id=new.message_id) WHERE message_id=new.message_id;
  END;
CREATE TRIGGER sent_contact_candidate_ad AFTER DELETE ON sent_recipients BEGIN
    DELETE FROM contact_candidates WHERE id='sent:'||old.message_id||':'||old.address;
  END;
CREATE TRIGGER sent_contact_candidate_ai AFTER INSERT ON sent_recipients BEGIN
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'sent:'||s.message_id||':'||s.address,s.account_id,s.message_id,s.address,
    COALESCE((SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),
      (SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),''),s.sent_at,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address) THEN 3.0 ELSE 2.0 END,2
    FROM sent_recipients s JOIN messages m ON m.id=s.message_id WHERE trim(s.address)!='' AND s.message_id=new.message_id AND s.address=new.address;
  END;
CREATE TRIGGER sent_contact_candidate_au AFTER UPDATE ON sent_recipients
    WHEN old.message_id!=new.message_id OR old.address!=new.address OR old.account_id!=new.account_id OR old.sent_at!=new.sent_at BEGIN
    DELETE FROM contact_candidates WHERE id='sent:'||old.message_id||':'||old.address;
    INSERT INTO contact_candidates(id,account_id,message_id,address,name,date,weight,source) SELECT 'sent:'||s.message_id||':'||s.address,s.account_id,s.message_id,s.address,
    COALESCE((SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),
      (SELECT NULLIF(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.name'),'') FROM json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address LIMIT 1),''),s.sent_at,
    CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(m.to_json) THEN m.to_json ELSE '[]' END) r WHERE lower(trim(json_extract(CASE WHEN r.type='object' THEN r.value ELSE '{}' END,'$.address')))=s.address) THEN 3.0 ELSE 2.0 END,2
    FROM sent_recipients s JOIN messages m ON m.id=s.message_id WHERE trim(s.address)!='' AND s.message_id=new.message_id AND s.address=new.address;
  END;
CREATE TRIGGER sent_message_insert AFTER INSERT ON messages
    WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') BEGIN
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN json_valid(new.to_json) THEN new.to_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN json_valid(new.cc_json) THEN new.cc_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
  END;
CREATE TRIGGER sent_message_update AFTER UPDATE OF account_id,from_addr,to_json,cc_json,date,labels_json ON messages
    WHEN old.account_id!=new.account_id OR old.from_addr!=new.from_addr OR old.to_json!=new.to_json OR old.cc_json!=new.cc_json OR old.date!=new.date OR old.labels_json!=new.labels_json BEGIN
    DELETE FROM sent_recipients WHERE message_id=new.id;
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') AND json_valid(new.to_json) THEN new.to_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
    INSERT OR IGNORE INTO sent_recipients SELECT new.id,new.account_id,lower(trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))),lower(trim(new.from_addr)),new.date FROM json_each(CASE WHEN EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(new.labels_json) THEN new.labels_json ELSE '[]' END) WHERE value='SENT') AND json_valid(new.cc_json) THEN new.cc_json ELSE '[]' END) WHERE trim(json_extract(CASE WHEN type='object' THEN value ELSE '{}' END,'$.address'))!='';
  END;
CREATE TRIGGER server_contact_candidate_ad AFTER DELETE ON server_contacts BEGIN
    DELETE FROM contact_candidates WHERE id='server:'||old.account_id||':'||old.address;
  END;
CREATE TRIGGER server_contact_candidate_ai AFTER INSERT ON server_contacts WHEN trim(new.address)!='' BEGIN
    INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'server:'||new.account_id||':'||new.address,new.account_id,new.address,new.name,0,0.2,3 WHERE trim(new.address)!='';
  END;
CREATE TRIGGER server_contact_candidate_au AFTER UPDATE ON server_contacts BEGIN
    DELETE FROM contact_candidates WHERE id='server:'||old.account_id||':'||old.address;
    INSERT INTO contact_candidates(id,account_id,address,name,date,weight,source)
      SELECT 'server:'||new.account_id||':'||new.address,new.account_id,new.address,new.name,0,0.2,3 WHERE trim(new.address)!='';
  END;
CREATE TRIGGER snoozed_list_date_delete AFTER DELETE ON snoozed_messages BEGIN
    UPDATE messages SET list_date=date WHERE account_id=old.account_id AND provider_id=old.provider_id;
  END;
CREATE TRIGGER snoozed_list_date_insert AFTER INSERT ON snoozed_messages BEGIN
    UPDATE messages SET list_date=MAX(date,COALESCE((SELECT woken_at FROM thread_reminders
      WHERE account_id=new.account_id AND thread_id=new.thread_id),0))
    WHERE account_id=new.account_id AND provider_id=new.provider_id;
  END;`,
  `CREATE INDEX messages_thread_participants ON messages(account_id,thread_id,from_addr,date,from_name);
   CREATE INDEX messages_starred_threads ON messages(account_id,thread_id) WHERE is_starred=1;`,
  // Migration 39: renew Outlook delta selections to backfill Focused/Other. Keep cached messages.
  `UPDATE accounts SET sync_cursor=NULL WHERE provider='outlook';
   UPDATE incoming_state SET inbox_cursor=NULL WHERE account_id IN (SELECT id FROM accounts WHERE provider='outlook');
   UPDATE account_organization SET selected_categories=NULL WHERE account_id IN (SELECT id FROM accounts WHERE provider='outlook');`,
];

/** Index of migration 37, the cache rowid rebuild. It runs when user_version equals this index. */
export const ROWID_REBUILD_MIGRATION = 36;

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

/** All migration runners use this boundary, outside their transaction. */
export function withMigrationForeignKeys<A, E, E2, R>(
  execute: (statement: string) => Effect.Effect<unknown, E>,
  work: Effect.Effect<A, E2, R>,
): Effect.Effect<A, E | E2, R> {
  return Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ foreign_keys: Schema.Number })),
    )(yield* execute("PRAGMA foreign_keys")).pipe(Effect.orDie);
    const enabled = rows[0]?.foreign_keys ?? 1;
    yield* execute("PRAGMA foreign_keys = OFF");
    return yield* work.pipe(
      Effect.ensuring(execute(`PRAGMA foreign_keys = ${enabled}`).pipe(Effect.orDie)),
    );
  }).pipe(Effect.uninterruptible);
}

const UserVersion = Schema.Struct({ user_version: Schema.Number });
/**
 * Runs pending migrations, one transaction each. The version is read inside
 * the transaction (BEGIN IMMEDIATE holds the write lock), so the app and the
 * CLI opening an old database at the same moment never run a step twice.
 */
export const migrateTo = (targetVersion: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Per connection, and a no-op inside a transaction, so they go first. The
    // app, the CLI and a restarting app can share the file; wait for a lock
    // instead of failing at once.
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`PRAGMA journal_size_limit = 8388608`;
    yield* sql`PRAGMA foreign_keys = ON`;
    const initialVersion = yield* sql`PRAGMA user_version`;
    if (initialVersion[0]?.user_version === 0) yield* sql`PRAGMA auto_vacuum=INCREMENTAL`;
    const step = sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql`PRAGMA user_version`;
        const { user_version: version } = yield* Schema.decodeUnknownEffect(UserVersion)(rows[0]);
        if (version >= targetVersion) return false;
        const migration = MIGRATIONS[version];
        if (migration === undefined) return false;
        for (const statement of splitStatements(migration)) yield* sql.unsafe(statement).unprepared;
        if (version === ROWID_REBUILD_MIGRATION) {
          const violations = yield* sql`PRAGMA foreign_key_check`;
          if (violations.length)
            return yield* Effect.die(new Error("Cache rowid migration violates foreign keys"));
        }
        yield* sql.unsafe(`PRAGMA user_version = ${version + 1}`).unprepared;
        return true;
      }),
    );
    const deadline = (yield* Clock.currentTimeMillis) + 120_000;
    let waiting = false;
    for (;;) {
      const rows = yield* sql`PRAGMA user_version`;
      const { user_version: version } = yield* Schema.decodeUnknownEffect(UserVersion)(rows[0]);
      if (version >= targetVersion) break;
      // Keep the FK boundary outside the transaction even if a peer advances
      // the version while we wait. Migration 37 preserves all rowids.
      const result = yield* Effect.result(
        withMigrationForeignKeys((statement) => sql.unsafe(statement).unprepared, step),
      );
      if (result._tag === "Success") {
        if (!result.success) break;
        continue;
      }
      const error = result.failure;
      if (
        !isSqlError(error) ||
        error.reason._tag !== "LockTimeoutError" ||
        (yield* Clock.currentTimeMillis) >= deadline
      )
        yield* Effect.fail(error);
      if (!waiting) {
        waiting = true;
        yield* Effect.logInfo("Waiting for another process to finish database migrations", {
          version,
          targetVersion,
          deadlineMs: 120_000,
        });
      }
      yield* Effect.sleep("100 millis");
    }
  });

export const migrate = migrateTo(MIGRATIONS.length);

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
