import { expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db/migrations.js";
import { applyNativeMigration } from "./migrations.js";
import { fixtureAccounts, fixtureMessage, fixtureOcrText } from "./fixtures/performance-mailbox.js";
import { PERF_FACTOR, perfBudget } from "../../../test-support/perf-budget.js";
import { perfCalibration } from "../../../test-support/perf-calibration.js";

const MESSAGES = 100_000;
/** Gapped rowids, as after deletes. A rebuild that renumbers rows breaks them and the FTS index. */
const rowidOf = (i: number) => i * 3 + 7;
/** Migration 37 on this fixture, with room for a loaded laptop. docs/performance.md has the measurements. */
const BUDGET_MS = 12_000;

/**
 * Today's Store queries columns that schema 36 lacks, so the 100k fixture goes in with plain SQL
 * that only names schema-36 columns. The schema-36 triggers fill FTS, the word tables, search
 * metadata, contact candidates and body sizes, as an upsert did at that version.
 */
const seedSchema36 = (db: DatabaseSync) => {
  const providers = ["gmail", "outlook", "imap"] as const;
  const account = db.prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,0)");
  const label = db.prepare("INSERT INTO labels(account_id,id,name,color) VALUES(?,?,?,NULL)");
  for (const [a, id] of fixtureAccounts.entries()) {
    account.run(id, providers[a] ?? "imap", `perf${a}@example.com`);
    for (let i = 0; i < (a === 2 ? 66 : 67); i++) label.run(id, `Folder_${i}`, `Folder ${i}`);
  }
  const message =
    db.prepare(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,
    from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred,
    body_cached,list_date,rfc_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`);
  const chunk = db.prepare(
    "INSERT INTO derived_chunks(message_id,text,provenance_json) VALUES(?,?,?)",
  );
  for (let start = 0; start < MESSAGES; start += 5000) {
    db.exec("BEGIN");
    for (let i = start; i < start + 5000; i++) {
      const m = fixtureMessage(i, true);
      const accountId = fixtureAccounts[Number(m.threadId.slice(6)) % 3] ?? "";
      const id = `${accountId}/${m.providerId}`;
      message.run(
        rowidOf(i),
        id,
        accountId,
        m.providerId,
        m.threadId,
        m.subject,
        m.from.name,
        m.from.address,
        JSON.stringify(m.to),
        JSON.stringify(m.cc),
        m.date,
        m.snippet,
        m.bodyText,
        m.bodyHtml,
        JSON.stringify(m.labels),
        JSON.stringify(m.attachments),
        m.isUnread ? 1 : 0,
        m.isStarred ? 1 : 0,
        m.date,
        m.rfcMessageId ?? null,
      );
      // One OCR chunk per attachment: 10k chunks, as in the search fixture.
      if (i % 10 === 0) {
        const text = fixtureOcrText(i);
        const source = { kind: "attachment", index: 0, name: "report.pdf" };
        chunk.run(id, text, JSON.stringify({ messageId: id, text, source, page: 1 }));
      }
    }
    db.exec("COMMIT");
  }
};

const count = (db: DatabaseSync, query: string) =>
  Number(Object.values(db.prepare(query).get() ?? {})[0]);

it(
  "measures migration 37 on a 100k-message schema-36 database",
  { skip: process.env.OPENMAIL_PERF !== "1", timeout: 600_000 },
  () => {
    // The fixed work runs first, on an idle process, so the ratio reflects the machine.
    const calibration = perfCalibration();
    const directory = mkdtempSync(join(tmpdir(), "openmail-migration37-perf-"));
    const file = join(directory, "mail.db");
    try {
      const db = new DatabaseSync(file);
      try {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192");
        for (const [index, migration] of MIGRATIONS.slice(0, 36).entries())
          applyNativeMigration(db, migration, index + 1);
        seedSchema36(db);
        db.exec("PRAGMA foreign_keys=ON");
        const rows = count(db, "SELECT COUNT(*) FROM messages");
        const candidates = count(db, "SELECT COUNT(*) FROM contact_candidates");
        const sample = db.prepare(
          "SELECT rowid,id FROM messages WHERE rowid % 997 = 0 ORDER BY id",
        );
        const before = sample.all();
        const bytes = count(db, "PRAGMA page_count") * count(db, "PRAGMA page_size");
        const start = performance.now();
        applyNativeMigration(db, MIGRATIONS[36] ?? "", 37);
        const elapsedMs = performance.now() - start;
        for (const [index, migration] of MIGRATIONS.entries())
          if (index > 36) applyNativeMigration(db, migration, index + 1);

        const budgetMs = perfBudget(BUDGET_MS) * Math.max(1, calibration.ratio);
        const report = {
          messages: rows,
          databaseBytes: bytes,
          elapsedMs,
          budgetMs,
          perfFactor: PERF_FACTOR,
          calibration,
          node: process.version,
        };
        writeFileSync(
          process.env.OPENMAIL_MIGRATION_REPORT ?? "/tmp/openmail-migration37-performance.json",
          JSON.stringify(report, null, 2),
        );
        process.stdout.write(
          `Migration 37: ${elapsedMs.toFixed(1)} ms (budget ${Math.round(budgetMs)} ms, calibration ratio ${calibration.ratio.toFixed(2)}), ${rows} messages, ${bytes} bytes\n`,
        );

        expect(rows).toBe(MESSAGES);
        expect(count(db, "PRAGMA user_version")).toBe(MIGRATIONS.length);
        expect(count(db, "SELECT COUNT(*) FROM messages")).toBe(MESSAGES);
        expect(count(db, "SELECT COUNT(*) FROM contact_candidates")).toBe(candidates);
        // Every row keeps its gapped rowid, so the external-content FTS tables still line up.
        expect(count(db, "SELECT COUNT(*) FROM messages WHERE rowid % 3 != 1")).toBe(0);
        expect(sample.all()).toEqual(before);
        expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        db.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
        expect(elapsedMs).toBeLessThan(budgetMs);
      } finally {
        db.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
