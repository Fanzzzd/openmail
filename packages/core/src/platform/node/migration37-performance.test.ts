import { it } from "vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db.js";
import { StoreLive } from "../../store.js";
import { NodeRuntime } from "./runtime.js";
import { applyNativeMigration } from "./migrations.js";
import { seedMailbox } from "./fixtures/performance-mailbox.js";

it(
  "measures migration 37 on the real 100k performance fixture",
  { skip: process.env.OPENMAIL_PERF !== "1", timeout: 300_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmail-migration37-perf-"));
    const file = join(directory, "mail.db");
    try {
      const legacy = new DatabaseSync(file);
      try {
        legacy.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192");
        for (const [index, migration] of MIGRATIONS.slice(0, 36).entries())
          applyNativeMigration(legacy, migration, index + 1);
      } finally {
        legacy.close();
      }
      await Effect.runPromise(
        seedMailbox(100_000).pipe(
          Effect.provide(
            StoreLive.pipe(
              Layer.provideMerge(Layer.merge(SqliteClient.layer({ filename: file }), NodeRuntime)),
            ),
          ),
        ),
      );
      const database = new DatabaseSync(file);
      try {
        database.exec("PRAGMA cache_size=-8192; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
        const rows = Number(database.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n);
        const bytes =
          Number(database.prepare("PRAGMA page_count").get()?.page_count) *
          Number(database.prepare("PRAGMA page_size").get()?.page_size);
        const start = performance.now();
        applyNativeMigration(database, MIGRATIONS[36] ?? "", 37);
        const elapsedMs = performance.now() - start;
        const report = { messages: rows, databaseBytes: bytes, elapsedMs, node: process.version };
        writeFileSync(
          process.env.OPENMAIL_MIGRATION_REPORT ?? "/tmp/openmail-migration37-performance.json",
          JSON.stringify(report, null, 2),
        );
        process.stdout.write(
          `Migration 37: ${elapsedMs.toFixed(1)} ms, ${rows} messages, ${bytes} bytes\n`,
        );
        database.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
