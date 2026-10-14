import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../../db/migrations.js";
import { applyNativeMigration } from "./migrations.js";

// R11: the word index backfill strips soft hyphens with an UPDATE on messages, which queued a
// new embedding for every older message that had one and dropped its thread's AI summary.
const migrated = () => {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS.slice(0, 54)) applyNativeMigration(db, migration);
  db.exec(`INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',1);
    INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
    VALUES('m','a','m','t','Inter­national','','','[]','[]',1,'','Con­gratu­lations','','["INBOX"]','[]',1,0);
    INSERT INTO vector_items(message_id,kind,version,provenance_json) VALUES('m','text','v1','{}');
    UPDATE semantic_jobs SET status='done';
    INSERT INTO derived(account_id,thread_id,kind,model,prompt_version,input_hash,text)
    VALUES('a','a/t','summary','model','1','hash','A summary');`);
  return db;
};

const state = (db: DatabaseSync) => ({
  job: db.prepare("SELECT status FROM semantic_jobs WHERE message_id='m'").get()?.status,
  vectors: db.prepare("SELECT COUNT(*) AS n FROM vector_items WHERE message_id='m'").get()?.n,
  summaries: db.prepare("SELECT COUNT(*) AS n FROM derived").get()?.n,
});

it("removing soft hyphens neither queues a new embedding nor drops the thread's summary", () => {
  const db = migrated();
  try {
    // The statement store-word-index.ts runs on rows stored before soft hyphens were dropped.
    db.exec(`UPDATE messages SET subject=replace(subject,char(173),''),body_text=replace(body_text,char(173),'')
      WHERE instr(subject,char(173))>0 OR instr(body_text,char(173))>0`);
    expect(db.prepare("SELECT subject,body_text FROM messages").get()).toEqual({
      subject: "International",
      body_text: "Congratulations",
    });
    expect(state(db)).toEqual({ job: "done", vectors: 1, summaries: 1 });
  } finally {
    db.close();
  }
});

it("a real change to the text still queues an embedding and drops the summary", () => {
  const db = migrated();
  try {
    db.exec("UPDATE messages SET body_text='Condolences'");
    expect(state(db)).toEqual({ job: "queued", vectors: 0, summaries: 0 });
  } finally {
    db.close();
  }
});
