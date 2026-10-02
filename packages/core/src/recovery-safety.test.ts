import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  linkSync,
  renameSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { acquireDatabaseAccess, DatabaseInUseError } from "./platform/node/database-access.js";
import { databaseLayer, MIGRATIONS } from "./platform/node/db.js";
import { NodeSystem } from "./platform/node/platform-node.js";
import { rebuildCorruptDatabase } from "./platform/node/database-recovery.js";
import {
  InterruptedRecoveryError,
  openDatabaseAccess,
  prepareDatabaseStartup,
} from "./platform/node/recovery-files.js";
const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "openmail-recovery-safety-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(dir: string, wal = false) {
  const file = join(dir, "mail.db");
  const db = new DatabaseSync(file);
  for (const migration of MIGRATIONS) db.exec(migration);
  const root = db
    .prepare("SELECT rootpage FROM sqlite_master WHERE name='messages'")
    .get()?.rootpage;
  const size = db.prepare("PRAGMA page_size").get()?.page_size;
  if (typeof root !== "number" || typeof size !== "number") throw new Error("No page metadata");
  if (wal) {
    db.exec("PRAGMA journal_mode=WAL");
    db.prepare("INSERT INTO prefs(key,value_json) VALUES (?,?)").run("wal-record", "true");
    const clone = temp();
    for (const suffix of ["", "-wal", "-shm"])
      copyFileSync(`${file}${suffix}`, `${join(clone, "mail.db")}${suffix}`);
    db.close();
    const bytes = readFileSync(join(clone, "mail.db"));
    bytes[(root - 1) * size] = 0;
    writeFileSync(join(clone, "mail.db"), bytes);
    return clone;
  }
  db.close();
  const bytes = readFileSync(file);
  bytes[(root - 1) * size] = 0;
  writeFileSync(file, bytes);
  return dir;
}
it("every core database layer keeps a shared lock lease until its SQLite connection is disposed", async () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`SELECT 1`;
      expect(() => acquireDatabaseAccess(file, "exclusive")).toThrow(DatabaseInUseError);
    }).pipe(
      Effect.provide(
        databaseLayer(file, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
      ),
    ),
  );
  const maintenance = acquireDatabaseAccess(file, "exclusive");
  maintenance.release();
  const probe = new DatabaseSync(file);
  try {
    probe.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
    probe.prepare("SELECT name FROM sqlite_master").get();
  } finally {
    probe.close();
  }
});
it("the lock file rejects fallback recovery even when the main database header is unreadable", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  writeFileSync(file, "unreadable header");
  const cli = acquireDatabaseAccess(file, "shared");
  try {
    expect(() => rebuildCorruptDatabase(dir)).toThrow(DatabaseInUseError);
    expect(readFileSync(file, "utf8")).toBe("unreadable header");
    expect(readdirSync(dir).some((name) => name.includes(".corrupt-"))).toBe(false);
  } finally {
    cli.release();
  }
  expect(rebuildCorruptDatabase(dir).kind).toBe("recovered");
});
it("startup never creates a new empty database when only an interrupted backup remains", () => {
  const dir = fixture(temp());
  const file = join(dir, "mail.db");
  const backup = `${file}.corrupt-legacy`;
  renameSync(file, backup);
  writeFileSync(`${file}.recovery-abandoned`, "partial recovery");
  expect(() => openDatabaseAccess(file)).toThrow(InterruptedRecoveryError);
  expect(existsSync(file)).toBe(false);
  expect(() => prepareDatabaseStartup(dir)).toThrow(InterruptedRecoveryError);
  expect(existsSync(backup)).toBe(true);
});
it("startup cleans partial recovery files and their journals while keeping the live database", () => {
  const dir = fixture(temp());
  const file = join(dir, "mail.db");
  const before = readFileSync(file);
  writeFileSync(`${file}.recovery-abandoned`, "partial");
  writeFileSync(`${file}.recovery-abandoned-journal`, "partial journal");
  prepareDatabaseStartup(dir);
  expect(readFileSync(file)).toEqual(before);
  expect(existsSync(`${file}.recovery-abandoned`)).toBe(false);
  expect(existsSync(`${file}.recovery-abandoned-journal`)).toBe(false);
});

// Kill the actual recovery subprocess at filesystem boundaries; JS finally blocks cannot hide a broken swap.
for (const step of ["sidecar", "linked", "installed"] as const)
  it(`process death after ${step} keeps a live path and cannot replay an old WAL into the replacement`, () => {
    const dir = fixture(temp(), true);
    const file = join(dir, "mail.db");
    const moduleUrl = new URL("../dist/platform/node/database-recovery.js", import.meta.url).href;
    const code = `
    import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    const file=${JSON.stringify(file)}, step=${JSON.stringify(step)};
    const rename=fs.renameSync, link=fs.linkSync;
    fs.renameSync=(from,to)=>{ rename(from,to); if(step==='sidecar' && from===file+'-wal') process.exit(71); if(step==='installed' && to===file && from.includes('.recovery-')) process.exit(71); };
    fs.linkSync=(from,to)=>{ link(from,to); if(step==='linked' && from===file) process.exit(71); };
    syncBuiltinESMExports(); const {rebuildCorruptDatabase}=await import(${JSON.stringify(moduleUrl)}); rebuildCorruptDatabase(${JSON.stringify(dir)});
  `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 15000,
    });
    expect(child.status, child.stderr).toBe(71);
    expect(existsSync(file)).toBe(true);
    const oldInode = statSync(file).ino;
    prepareDatabaseStartup(dir);
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith("mail.db.recovery-"))).toEqual([]);
    const db = new DatabaseSync(file);
    try {
      expect(
        db.prepare("SELECT value_json FROM prefs WHERE key='wal-record'").get()?.value_json,
      ).toBe("true");
      if (step === "installed")
        expect(db.prepare("PRAGMA quick_check").get()?.quick_check).toBe("ok");
    } finally {
      db.close();
    }
    expect(statSync(file).ino).toBe(oldInode);
  });
it("a failed post-swap marker cannot make startup copy backup WALs onto a valid new database", () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const old = new DatabaseSync(file);
  for (const migration of MIGRATIONS) old.exec(migration);
  old.close();
  const identity = statSync(file);
  const backup = `${file}.corrupt-test`;
  linkSync(file, backup);
  const fresh = `${file}.recovery-test`;
  const db = new DatabaseSync(fresh);
  for (const migration of MIGRATIONS) db.exec(migration);
  db.prepare("INSERT INTO prefs(key,value_json) VALUES (?,?)").run("new-only", "true");
  db.close();
  renameSync(fresh, file);
  writeFileSync(`${backup}-wal`, "old stale WAL");
  writeFileSync(`${backup}-shm`, "old stale SHM");
  writeFileSync(
    `${file}.recovery-state.json`,
    JSON.stringify({
      backup: basename(backup),
      fresh: basename(fresh),
      device: identity.dev,
      inode: identity.ino,
    }),
  );
  prepareDatabaseStartup(dir);
  expect(existsSync(`${file}-wal`)).toBe(false);
  const after = new DatabaseSync(file);
  try {
    expect(
      after.prepare("SELECT value_json FROM prefs WHERE key='new-only'").get()?.value_json,
    ).toBe("true");
  } finally {
    after.close();
  }
});

it("old corrupt backups without recovery markers do not block an intentional fresh start", async () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const seed = new DatabaseSync(file);
  for (const migration of MIGRATIONS) seed.exec(migration);
  seed.close();
  const result = rebuildCorruptDatabase(dir);
  expect(result.kind).toBe("recovered");
  rmSync(file);
  expect(() => prepareDatabaseStartup(dir)).not.toThrow();
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      expect((yield* sql`SELECT COUNT(*) AS n FROM accounts`)[0]?.n).toBe(0);
    }).pipe(
      Effect.provide(
        databaseLayer(file, { vectorExtension: null }).pipe(Layer.provide(NodeSystem)),
      ),
    ),
  );
  expect(existsSync(file)).toBe(true);
  if (result.kind === "recovered") expect(existsSync(result.backup)).toBe(true);
});

it("four simultaneous first openers hold shared leases quickly without initializing the lock database", async () => {
  const dir = temp();
  const file = join(dir, "mail.db");
  const start = join(dir, "start");
  const url = new URL("../dist/platform/node/database-access.js", import.meta.url).href;
  const results = await Promise.all(
    [0, 1, 2, 3].map(async (id) => {
      const ready = join(dir, `ready-${id}`);
      const result = join(dir, `result-${id}`);
      const code = `import fs from 'node:fs'; const {acquireDatabaseAccess}=await import(${JSON.stringify(url)}); fs.writeFileSync(${JSON.stringify(ready)},'ready'); while(!fs.existsSync(${JSON.stringify(start)})) await new Promise(r=>setTimeout(r,2)); const at=Date.now(); const lease=acquireDatabaseAccess(${JSON.stringify(file)},'shared'); fs.writeFileSync(${JSON.stringify(result)},String(Date.now()-at)); await new Promise(r=>setTimeout(r,150)); lease.release();`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        stdio: "ignore",
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      try {
        const deadline = Date.now() + 5000;
        while (![0, 1, 2, 3].every((n) => existsSync(join(dir, `ready-${n}`)))) {
          if (Date.now() > deadline) throw new Error("First openers failed to reach the barrier");
          await new Promise((resolve) => {
            setTimeout(resolve, 5);
          });
        }
        if (!existsSync(start)) writeFileSync(start, "go");
        const code = await exit;
        return { code, elapsed: Number(readFileSync(result, "utf8")) };
      } finally {
        if (child.exitCode === null) child.kill();
      }
    }),
  );
  for (const result of results) {
    expect(result.code).toBe(0);
    expect(result.elapsed).toBeLessThan(1000);
  }
  expect(statSync(`${file}.access-lock`).size).toBe(0);
});
