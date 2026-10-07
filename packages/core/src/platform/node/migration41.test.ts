import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MIGRATIONS, splitStatements } from "../../db.js";
import type { DerivedChunk } from "../../media.js";
import { applyNativeMigration } from "./migrations.js";

for (const partialWords of [false, true]) {
  it(`migration 41 removes only same-message duplicates with ${partialWords ? "partial" : "complete"} word FTS`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      for (const [index, migration] of MIGRATIONS.slice(0, 40).entries())
        applyNativeMigration(db, migration, index + 1);
      db.exec(
        "INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',0)",
      );
      for (const id of ["original", "forward"])
        db.prepare(`INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
          VALUES(?,'a',?,'thread','','','','[]','[]',0,'','','','[]','[]',0,0)`).run(id, id);
      const insert = db.prepare(
        "INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(?,?,?)",
      );
      const chunk: DerivedChunk = {
        messageId: "original",
        text: "boarding invoice",
        source: { kind: "attachment", index: 0, name: "report.pdf", mimeType: "application/pdf" },
        page: 1,
        region: null,
        pipelineVersion: "old",
        visionRevision: null,
      };
      const add = (chunk: DerivedChunk) =>
        Number(insert.run(chunk.messageId, chunk.text, JSON.stringify(chunk)).lastInsertRowid);
      const retained = add(chunk);
      const duplicate = add(chunk);
      add({ ...chunk, page: 2 }); // Same words on another page are legitimate.
      add({
        ...chunk,
        source: { ...chunk.source, kind: "attachment", index: 1, mimeType: "application/pdf" },
      });
      add({ ...chunk, messageId: "forward" });
      add({
        ...chunk,
        messageId: "forward",
        source: { kind: "inline", cid: "scan", name: "scan.png", mimeType: "image/png" },
      });
      db.exec("UPDATE derived_jobs SET status='done'; UPDATE semantic_jobs SET status='done'");
      if (partialWords) {
        db.prepare("INSERT INTO derived_words(derived_words,rowid,text) VALUES('delete',?,?)").run(
          duplicate,
          chunk.text,
        );
        db.prepare("DELETE FROM search_word_rows WHERE kind='derived' AND row_id=?").run(duplicate);
        db.exec("UPDATE search_word_index SET ready=0 WHERE kind='derived'");
      }
      const migration = MIGRATIONS[40];
      expect(migration).toBeDefined();
      if (!migration) throw new Error("Missing migration 41");
      applyNativeMigration(db, migration, 41);
      expect(db.prepare("SELECT id FROM derived_chunks WHERE id=?").get(retained)).toBeDefined();
      expect(db.prepare("SELECT id FROM derived_chunks WHERE id=?").get(duplicate)).toBeUndefined();
      expect(db.prepare("SELECT id FROM derived_chunks").all()).toHaveLength(5);
      expect(
        db.prepare("SELECT id FROM derived_chunks WHERE message_id='forward'").all(),
      ).toHaveLength(2);
      expect(
        db.prepare("SELECT status FROM derived_jobs WHERE message_id='original'").get()?.status,
      ).toBe("queued");
      expect(
        db.prepare("SELECT status FROM semantic_jobs WHERE message_id='original'").get()?.status,
      ).toBe("queued");
      expect(
        db.prepare("SELECT status FROM semantic_jobs WHERE message_id='forward'").get()?.status,
      ).toBe("done");
      for (const table of ["derived_fts", "derived_words"]) {
        db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
        expect(
          db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH 'boarding'`).all(),
        ).toHaveLength(5);
      }
      expect(
        db
          .prepare(
            "SELECT row_id FROM search_word_rows WHERE kind='derived' AND row_id NOT IN (SELECT id FROM derived_chunks)",
          )
          .all(),
      ).toHaveLength(0);
      const withPosition = { ...chunk, chunkIndex: 0 };
      expect(() =>
        db
          .prepare(
            "INSERT INTO derived_chunks(message_id,text,provenance_json,chunk_index) VALUES(?,?,?,?)",
          )
          .run(chunk.messageId, chunk.text, JSON.stringify(withPosition), 0),
      ).toThrow(/UNIQUE/);
      // A worker on another connection sees the version and does not rerun the migration.
      applyNativeMigration(db, migration, 41);
      expect(db.prepare("SELECT id FROM derived_chunks").all()).toHaveLength(5);
    } finally {
      db.close();
    }
  });
}

it("migration 41 backfills 10k chunks in a 100k-message fixture within three seconds", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const [index, migration] of MIGRATIONS.slice(0, 40).entries())
      applyNativeMigration(db, migration, index + 1);
    db.exec(
      "INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',0)",
    );
    db.exec(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<100000)
      INSERT INTO messages(id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
      SELECT 'a/'||n,'a',CAST(n AS TEXT),CAST(n AS TEXT),'','','','[]','[]',n,'','','','[]','[]',0,0 FROM fixture`);
    db.exec(`WITH RECURSIVE fixture(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM fixture WHERE n<10000)
      INSERT INTO derived_chunks(message_id,text,provenance_json)
      SELECT 'a/'||((n-1)/10+1),'boarding invoice',json_object(
        'messageId','a/'||((n-1)/10+1),'text','boarding invoice',
        'source',json_object('kind','attachment','index',0,'name','report.pdf','mimeType','application/pdf'),
        'page',(n-1)%10+1,'region',NULL,'pipelineVersion','old','visionRevision',NULL)
      FROM fixture`);
    // One genuinely ambiguous message must be requeued, without disturbing the rest.
    db.exec(`INSERT INTO derived_chunks(message_id,text,provenance_json)
      SELECT message_id,text,provenance_json FROM derived_chunks WHERE id=1;
      UPDATE derived_jobs SET status='done'; UPDATE semantic_jobs SET status='done';`);
    const migration = MIGRATIONS[40];
    if (!migration) throw new Error("Missing migration 41");
    const steps = splitStatements(migration);
    const update = steps.find((step) => step.includes("ROW_NUMBER"));
    if (!update) throw new Error("Missing chunk position backfill");
    db.exec("SAVEPOINT explain_backfill");
    let correlated = false;
    try {
      for (const step of steps.slice(0, 2)) db.exec(step);
      correlated = db
        .prepare(`EXPLAIN QUERY PLAN ${update}`)
        .all()
        .some((row) => String(row.detail).includes("CORRELATED SCALAR SUBQUERY"));
    } finally {
      db.exec("ROLLBACK TO explain_backfill; RELEASE explain_backfill");
    }
    expect(correlated, "the window must be evaluated once, not once per chunk").toBe(false);
    const started = performance.now();
    applyNativeMigration(db, migration, 41);
    const elapsed = performance.now() - started;
    expect(elapsed, "10k chunk backfill must finish within three seconds").toBeLessThan(3000);
    process.stdout.write(`Migration 41: ${elapsed.toFixed(1)} ms, 100k messages, 10k chunks\n`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM derived_chunks").get()?.n).toBe(10000);
    expect(db.prepare("SELECT 1 FROM derived_chunks WHERE chunk_index IS NULL").all()).toHaveLength(
      0,
    );
    expect(
      db
        .prepare(`SELECT message_id FROM derived_chunks GROUP BY message_id
      HAVING COUNT(*)!=10 OR MIN(chunk_index)!=0 OR MAX(chunk_index)!=9`)
        .all(),
    ).toHaveLength(0);
    for (const table of ["derived_fts", "derived_words"])
      db.exec(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`);
    for (const table of ["derived_jobs", "semantic_jobs"])
      expect(db.prepare(`SELECT message_id FROM ${table} WHERE status='queued'`).all()).toEqual([
        { message_id: "a/1" },
      ]);
  } finally {
    db.close();
  }
}, 60_000);
