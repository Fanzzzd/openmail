import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../../db/migrations.js";
import { applyNativeMigration } from "./migrations.js";

it("migration 40 leaves missing vectors for lazy repair when vec0 is unavailable", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 39)) applyNativeMigration(db, migration);
    db.exec(`INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',1);
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES('m','a','m','t','','','','[]','[]',1,'','refilled text','','["INBOX"]','[]',1,0);
      INSERT INTO vector_items(message_id,kind,version,provenance_json) VALUES('m','text','v1','{}');
      UPDATE semantic_jobs SET status='done',attempts=3,retry_at=999,note='old';`);
    applyNativeMigration(db, MIGRATIONS[39] ?? "");
    expect(
      db
        .prepare("SELECT status,attempts,retry_at,note FROM semantic_jobs WHERE message_id='m'")
        .get(),
    ).toEqual({ status: "done", attempts: 3, retry_at: 999, note: "old" });
  } finally {
    db.close();
  }
});

it("migration 40 leaves completed OCR jobs alone", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 39)) applyNativeMigration(db, migration);
    db.exec(`INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',1);
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      VALUES('m','a','m','t','','','','[]','[]',1,'','refilled text','<img src="cid:new">','["INBOX"]','[]',1,0);
      INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES('m','Old receipt','{}');
      UPDATE derived_jobs SET status='done',attempts=3,retry_at=999,note='old';`);
    applyNativeMigration(db, MIGRATIONS[39] ?? "");
    expect(
      db
        .prepare("SELECT status,attempts,retry_at,note FROM derived_jobs WHERE message_id='m'")
        .get(),
    ).toEqual({ status: "done", attempts: 3, retry_at: 999, note: "old" });
  } finally {
    db.close();
  }
});

it("migration 40 queues zero jobs in a healthy 100k-style corpus without vec0", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 39)) applyNativeMigration(db, migration);
    // Seeding FTS/contact projections is covered by the performance corpus.
    // Keep only the indexing projections involved in this migration fixture.
    for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) {
      if (
        typeof row.name === "string" &&
        !["semantic_message_update", "media_message_update"].includes(row.name)
      )
        db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
    }
    db.exec(`INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',1);
      WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<100000)
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      SELECT 'm'||n,'a','m'||n,'t'||n,'','','','[]','[]',n,'','healthy','<img src="cid:scan">','["INBOX"]','[]',0,0 FROM ids;
      INSERT INTO vector_items(message_id,kind,version,provenance_json) SELECT id,'text','v1','{}' FROM messages;
      INSERT INTO semantic_jobs(message_id,status) SELECT id,'done' FROM messages;
      INSERT INTO derived_jobs(message_id,status) SELECT id,'done' FROM messages;
      INSERT INTO derived_chunks(message_id,text,provenance_json) SELECT id,'healthy OCR','{}' FROM messages;`);
    applyNativeMigration(db, MIGRATIONS[39] ?? "");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM semantic_jobs WHERE status!='done'").get()?.n,
    ).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM derived_jobs WHERE status!='done'").get()?.n).toBe(
      0,
    );
  } finally {
    db.close();
  }
});
