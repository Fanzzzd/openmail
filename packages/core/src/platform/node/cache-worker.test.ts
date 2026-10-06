import { databaseLayer } from "./db.js";
import { NodeSystem } from "./platform-node.js";
import { SqlClient } from "effect/sql";
import { Effect, Logger, Layer } from "effect";
import { expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db.js";
import { applyNativeMigration } from "./migrations.js";
import { checkDatabaseUpgradeSpace, DatabaseUpgradeSpaceError } from "./database-upgrade.js";
import { nodeCacheMaintenance } from "./cache-maintenance.js";
import { acquireDatabaseAccess, registerDatabaseLease } from "./database-access.js";

function fixture(version = 37) {
  const directory = mkdtempSync(join(tmpdir(), "openmail-worker-test-"));
  const file = join(directory, "mail.db");
  const db = new DatabaseSync(file);
  for (const [index, script] of MIGRATIONS.slice(0, version).entries())
    applyNativeMigration(db, script, index + 1);
  db.exec(
    "INSERT INTO accounts(id,provider,email,created_at) VALUES('a','gmail','a@example.com',0)",
  );
  db.exec(`INSERT INTO messages(rowid,id,account_id,provider_id,thread_id,subject,from_name,from_addr,to_json,cc_json,date,snippet,body_text,body_html,labels_json,attachments_json,is_unread,is_starred)
    VALUES(41,'a/m','a','m','a/t','needle','Alice','alice@example.com','[]','[]',0,'','cached text','','["INBOX"]','[]',1,0)`);
  db.close();
  return { file, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}

it("runs VACUUM in a worker while the caller's event loop keeps responding", async () => {
  const database = fixture();
  // oxlint-disable-next-line typescript/unbound-method
  const prepare = DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method
  const exec = DatabaseSync.prototype.exec;
  const forbidVacuum = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (/\bVACUUM\b/iu.test(sql)) throw new Error("VACUUM on the caller thread");
    return prepare.call(this, sql);
  });
  const forbidExec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql,
  ) {
    if (/\bVACUUM\b/iu.test(sql)) throw new Error("VACUUM on the caller thread");
    return exec.call(this, sql);
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    expect(
      await Effect.runPromise(
        nodeCacheMaintenance.run({ file: database.file, kind: "compact", full: true }),
      ),
    ).toBe("done");
    expect(ticks).toBeGreaterThan(0);
    const db = new DatabaseSync(database.file);
    try {
      expect(db.prepare("SELECT rowid FROM messages").get()?.rowid).toBe(41);
      expect(
        db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'needle'").get()?.rowid,
      ).toBe(41);
    } finally {
      db.close();
    }
  } finally {
    clearInterval(timer);
    forbidVacuum.mockRestore();
    forbidExec.mockRestore();
    database.dispose();
  }
});

it("refuses an idle CLI access lease, then compacts after it closes and restores our shared lease", async () => {
  const database = fixture();
  const lease = acquireDatabaseAccess(database.file, "shared");
  const unregister = registerDatabaseLease(database.file, lease);
  const child = fork(
    new URL("./fixtures/cache-access-holder.mjs", import.meta.url),
    [database.file],
    { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Access holder exited early")));
    });
    expect(
      await Effect.runPromise(
        nodeCacheMaintenance.run({ file: database.file, kind: "compact", full: true }),
      ),
    ).toBe("busy");
    const closed = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });
    child.send("close");
    await closed;
    expect(
      await Effect.runPromise(
        nodeCacheMaintenance.run({ file: database.file, kind: "compact", full: true }),
      ),
    ).toBe("done");
    const second = acquireDatabaseAccess(database.file, "shared");
    try {
      expect(
        await Effect.runPromise(
          nodeCacheMaintenance.run({ file: database.file, kind: "compact", full: true }),
        ),
      ).toBe("busy");
    } finally {
      second.release();
    }
  } finally {
    child.kill();
    unregister();
    lease.release();
    database.dispose();
  }
});

it("returns busy for an unregistered SQLite writer instead of a generic failure", async () => {
  const database = fixture();
  const writer = new DatabaseSync(database.file);
  try {
    writer.exec("BEGIN IMMEDIATE");
    expect(
      await Effect.runPromise(
        nodeCacheMaintenance.run({ file: database.file, kind: "compact", full: true }),
      ),
    ).toBe("busy");
    writer.exec("ROLLBACK");
  } finally {
    writer.close();
    database.dispose();
  }
});

it("checks upgrade space before changing database bytes or dependent records", () => {
  const database = fixture(36);
  const bytes = readFileSync(database.file);
  const db = new DatabaseSync(database.file);
  try {
    expect(() => checkDatabaseUpgradeSpace(db, 0)).toThrow(DatabaseUpgradeSpaceError);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(36);
    expect(db.prepare("SELECT count(*) AS n FROM message_badges").get()?.n).toBe(1);
  } finally {
    db.close();
  }
  expect(readFileSync(database.file)).toEqual(bytes);
  database.dispose();
});

it("reports a committed upgrade as done when a reader defers the final WAL checkpoint", async () => {
  const database = fixture(36);
  const writer = new DatabaseSync(database.file);
  const reader = new DatabaseSync(database.file);
  const warnings: unknown[] = [];
  const logger = Logger.layer([
    Logger.make(({ message }) => {
      warnings.push(message);
    }),
  ]);
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM messages").all();
    const result = await Effect.runPromise(
      nodeCacheMaintenance
        .run({
          file: database.file,
          kind: "upgrade",
          script: MIGRATIONS[36] ?? "",
          version: 37,
        })
        .pipe(Effect.provide(logger)),
    );
    expect(writer.prepare("PRAGMA user_version").get()?.user_version).toBe(37);
    expect(result).toBe("done");
    expect(JSON.stringify(warnings)).toContain("WAL checkpoint deferred");
  } finally {
    reader.close();
    writer.close();
    database.dispose();
  }
});

it("startup continues after one committed upgrade with a pinned WAL reader", async () => {
  const database = fixture(36);
  const writer = new DatabaseSync(database.file);
  const reader = new DatabaseSync(database.file);
  let started = 0;
  let dismissed = 0;
  const logs: unknown[] = [];
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    reader.exec("BEGIN");
    reader.prepare("SELECT id FROM messages").all();
    const startup = databaseLayer(database.file, {
      vectorExtension: null,
      onDatabaseUpgrade: async () => {
        started++;
        return () => {
          dismissed++;
        };
      },
    }).pipe(Layer.provide(NodeSystem));
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        expect((yield* sql`PRAGMA user_version`)[0]?.user_version).toBe(37);
        expect((yield* sql`SELECT count(*) AS n FROM message_search_meta`)[0]?.n).toBe(1);
      }).pipe(
        Effect.provide(startup),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ]),
        ),
      ),
    );
    expect(started).toBe(1);
    expect(dismissed).toBe(1);
    expect(JSON.stringify(logs)).toContain("WAL checkpoint deferred");
    expect(JSON.stringify(logs)).not.toContain("Waiting for another process");
  } finally {
    reader.close();
    writer.close();
    database.dispose();
  }
});
