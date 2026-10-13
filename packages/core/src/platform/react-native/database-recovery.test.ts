import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../../db.js";
import { applyNativeMigration } from "../node/migrations.js";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Clock, Effect, FileSystem, Layer, ManagedRuntime, PlatformError, Schema } from "effect";
import { expectFileBytes } from "../../../test-support/file-bytes.js";
import { writeMigratedDatabase } from "../../../test-support/migrated-database.js";
import { opSqliteShim } from "../../../test-support/op-sqlite.js";
import { AppPaths } from "../paths.js";
import { PlatformCrypto, sha256Hex, hmacSha256Hex } from "../crypto.js";
import { TestMailbox, fakeServer, incoming } from "../node/testing.js";
import { Mailbox } from "../../mailbox/mailbox.js";
import { Store } from "../../services.js";
import type { OpSqliteDatabase } from "./sqlite.js";
import {
  MobileDatabaseRecovery,
  mobileDatabaseRecoveryLayer,
  MOBILE_DATABASE_CHECK_MAX_AGE_MS,
} from "./database-recovery.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmail-mobile-recovery-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const fs = await Effect.runPromise(
    FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
  );
  const time = { now: 1000 };
  const baseClock = await Effect.runPromise(Clock.Clock);
  let serial = 0;
  const stats = { checks: 0, copies: 0 };
  const interrupted: { value: { marker: string; freshPath: string; bytes: Uint8Array } | null } = {
    value: null,
  };
  const failures = {
    corrupt: false,
    copy: false,
    partialCopy: false,
    rename: false,
    renameGeneric: false,
    receipt: false,
    diskFull: false,
    profile: false,
    header: false,
    targetOpen: false,
    targetFull: false,
    profileScan: false,
    markerRead: false,
    markerWrite: false,
    targetCheck: false,
    replacementOpen: false,
    replacementQuery: false,
    foregroundWrite: false,
  };
  const handles = new Set<OpSqliteDatabase>();
  const openDatabase = ({
    name,
    location,
    readOnly,
  }: {
    name: string;
    location: string;
    readOnly: boolean;
  }): OpSqliteDatabase => {
    if (readOnly && name.startsWith("mail.db.recovery-") && failures.replacementOpen)
      throw new Error("database is locked");
    if (name.startsWith("mail.db.recovery-") && failures.targetOpen) throw new Error("disk full");
    if ((name === "mail.db" || name.startsWith("mail.db.corrupt-")) && failures.header)
      throw new Error("file is not a database");
    const db = opSqliteShim(join(location, name), readOnly).open();
    handles.add(db);
    return {
      ...db,
      close: () => {
        db.close();
        handles.delete(db);
      },
      execute: async (query, params) => {
        if (query === "PRAGMA quick_check" && name === "mail.db") stats.checks++;
        if (
          query === "PRAGMA quick_check" &&
          readOnly &&
          name.startsWith("mail.db.recovery-") &&
          failures.replacementQuery
        )
          throw new Error("database is locked");
        if (
          query === "PRAGMA quick_check" &&
          name.startsWith("mail.db.recovery-") &&
          failures.targetCheck
        )
          return { rows: [{ quick_check: "malformed" }], rowsAffected: 0 };
        if (
          name.startsWith("mail.db.recovery-") &&
          failures.targetFull &&
          query.startsWith('INSERT INTO "accounts"')
        )
          throw new Error("disk I/O error");
        if (
          (name === "mail.db" || name.startsWith("mail.db.corrupt-")) &&
          failures.profileScan &&
          ((query.startsWith("SELECT rowid AS recovery_rowid") &&
            query.includes('FROM "profiles"')) ||
            (query ===
              'SELECT "id","name","icon","color","position" FROM "profiles" WHERE rowid=?' &&
              params?.[0] === 1))
        )
          throw new Error("database disk image is malformed");
        if (name === "mail.db" && failures.diskFull) throw new Error("disk I/O error");
        if (name === "mail.db" && failures.corrupt && query === "PRAGMA quick_check")
          return { rows: [{ quick_check: "database disk image is malformed" }], rowsAffected: 0 };
        if (
          (name === "mail.db" || name.startsWith("mail.db.corrupt-")) &&
          failures.profile &&
          query === 'PRAGMA table_info("profiles")'
        )
          throw new Error("database disk image is malformed");
        return db.execute(query, params);
      },
    };
  };
  const ioError = (method: string) =>
    Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method }));
  const storage = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      exists: fs.exists,
      remove: fs.remove,
      readFileString: (path) =>
        failures.markerRead && path.endsWith(".recovery-state.json")
          ? ioError("readFileString")
          : fs.readFileString(path),
      readDirectory: fs.readDirectory,
      copyFile: (source, target) => {
        if (source.endsWith("/mail.db")) stats.copies++;
        if (failures.partialCopy && source.endsWith("/mail.db"))
          return fs.writeFileString(target, "partial database").pipe(
            Effect.flatMap(() =>
              Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "copyFile",
                  description: "ENOSPC: disk full",
                }),
              ),
            ),
          );
        return failures.copy ? ioError("copyFile") : fs.copyFile(source, target);
      },
      rename: (source, target) => {
        if ((failures.rename || failures.renameGeneric) && target.endsWith("/mail.db")) {
          interrupted.value = {
            marker: readFileSync(join(root, "mail.db.recovery-state.json"), "utf8"),
            freshPath: source,
            bytes: readFileSync(source),
          };
          return failures.renameGeneric
            ? Effect.sync(() => {
                throw new Error("generic native rename failure");
              })
            : ioError("rename");
        }
        return fs.rename(source, target).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (target.endsWith("/mail.db")) {
                failures.corrupt = false;
                failures.header = false;
              }
            }),
          ),
        );
      },
      writeFileString: (path, value, options) =>
        failures.foregroundWrite && path.includes(".foreground-check.json")
          ? ioError("writeFileString")
          : failures.markerWrite && path.endsWith(".recovery-state.json.tmp")
            ? fs.writeFileString(path, "{").pipe(Effect.flatMap(() => ioError("writeFileString")))
            : failures.receipt && path.includes(".recovered.json")
              ? ioError("writeFileString")
              : fs.writeFileString(path, value, options),
    }),
  );
  const createLayer = () =>
    mobileDatabaseRecoveryLayer(openDatabase).pipe(
      Layer.provide(
        Layer.mergeAll(
          storage,
          Layer.succeed(Clock.Clock, {
            currentTimeMillisUnsafe: () => time.now,
            currentTimeMillis: Effect.sync(() => time.now),
            currentTimeNanosUnsafe: () => baseClock.currentTimeNanosUnsafe(),
            currentTimeNanos: baseClock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => BigInt(time.now) * 1_000_000n,
            monotonicTimeNanos: Effect.sync(() => BigInt(time.now) * 1_000_000n),
            sleep: (duration) => baseClock.sleep(duration),
          }),
          Layer.succeed(AppPaths, { dataDirectory: Effect.succeed(root) }),
          Layer.succeed(PlatformCrypto, {
            sha256: sha256Hex,
            hmac: hmacSha256Hex,
            randomUUID: () => `test-${++serial}`,
          }),
        ),
      ),
    );
  const createRuntime = () => {
    const instance = ManagedRuntime.make(createLayer());
    cleanups.push(() => instance.dispose());
    return instance;
  };
  const runtime = createRuntime();
  const recovery = await runtime.runPromise(MobileDatabaseRecovery);
  writeMigratedDatabase(join(root, "mail.db"));
  const seed = new DatabaseSync(join(root, "mail.db"));
  try {
    seed.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF");
    seed.exec(`
      BEGIN;
      INSERT INTO profiles (id,name,icon,color,position) VALUES ('p','Personal','mail','blue',0);
      INSERT INTO accounts (id,provider,email,created_at,profile_id,sync_cursor,last_synced_at) VALUES ('a','gmail','me@example.test',1,'p','stale',1);
      INSERT INTO drafts (id,account_id,message_json,updated_at) VALUES ('draft','a','{"subject":"offline draft"}',1);
      INSERT INTO prefs (key,value_json) VALUES ('language','"zh-CN"');
      COMMIT;
    `);
  } finally {
    seed.close();
  }
  return {
    root,
    failures,
    handles,
    stats,
    interrupted,
    time,
    runtime,
    createRuntime,
    recovery,
    run: runtime.runPromise.bind(runtime),
  };
}

async function crashedSwap(f: Awaited<ReturnType<typeof fixture>>) {
  f.failures.corrupt = true;
  f.failures.rename = true;
  expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
  // Recreate the last on-disk state before an uncatchable process interruption.
  const interrupted = f.interrupted.value;
  if (!interrupted) throw new Error("No prepared swap");
  writeFileSync(interrupted.freshPath, interrupted.bytes);
  writeFileSync(join(f.root, "mail.db.recovery-state.json"), interrupted.marker);
}

describe("mobile database recovery", () => {
  it("checks integrity on open, refuses corrupt storage, and preserves unavailable storage", async () => {
    const f = await fixture();
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "healthy" });
    const db = await f.run(f.recovery.open());
    db.close();
    f.failures.corrupt = true;
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "corrupt" });
    const blocked = await f.run(f.recovery.open().pipe(Effect.result));
    expect(blocked._tag === "Failure" && blocked.failure.reason).toBe("corrupt");
    f.failures.diskFull = true;
    const unavailable = await f.run(f.recovery.inspect({ force: true }).pipe(Effect.result));
    expect(unavailable._tag === "Failure" && unavailable.failure.reason).toBe("unavailable");
    expect(
      readdirSync(f.root).filter(
        (name) =>
          !["mail.db", "mail.db-wal", "mail.db-shm", "mail.db.foreground-check.json"].includes(
            name,
          ),
      ),
    ).toEqual([]);
  });

  for (const version of [38, 39]) {
    it(`mobile recovery normalizes pre-39 Outlook categories and preserves version ${version} choices`, async () => {
      const f = await fixture();
      const file = join(f.root, "mail.db");
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      const source = new DatabaseSync(file);
      for (const [index, migration] of MIGRATIONS.slice(0, version).entries())
        applyNativeMigration(source, migration, index + 1);
      const categories =
        '["CATEGORY_PERSONAL","CATEGORY_SOCIAL","CATEGORY_PROMOTIONS","CATEGORY_UPDATES","CATEGORY_FORUMS"]';
      for (const provider of ["outlook", "gmail", "imap"]) {
        source
          .prepare("INSERT INTO accounts(id,provider,email,created_at) VALUES(?,?,?,1)")
          .run(provider, provider, `${provider}@example.com`);
        source
          .prepare(
            "INSERT INTO account_organization(account_id,categories,selected_categories) VALUES(?,1,?)",
          )
          .run(provider, categories);
      }
      source.close();
      f.failures.corrupt = true;
      expect((await f.run(f.recovery.rebuild)).copied).toBe(6);
      const recovered = await f.run(f.recovery.open());
      try {
        for (const provider of ["outlook", "gmail", "imap"])
          expect(
            (
              await recovered.execute(
                "SELECT selected_categories FROM account_organization WHERE account_id=?",
                [provider],
              )
            ).rows,
          ).toEqual([
            { selected_categories: provider === "outlook" && version < 39 ? null : categories },
          ]);
      } finally {
        recovered.close();
      }
    });
  }

  it("salvages user records, clears sync cursors, re-syncs providers, and keeps quarantine bytes", async () => {
    const f = await fixture();
    const before = readFileSync(join(f.root, "mail.db"));
    f.failures.corrupt = true;
    const report = await f.run(f.recovery.rebuild);
    expect(report.copied).toBe(4);
    expect(report.skipped).toBe(0);
    expectFileBytes(join(f.root, report.backup), before);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "recovered", report });
    const native = await f.run(f.recovery.open());
    expect(
      (
        await native.execute(
          "SELECT profile_id,sync_cursor,last_synced_at,last_sync_error FROM accounts",
        )
      ).rows,
    ).toEqual([
      { profile_id: "p", sync_cursor: null, last_synced_at: null, last_sync_error: null },
    ]);
    expect((await native.execute("SELECT message_json FROM drafts")).rows).toEqual([
      { message_json: '{"subject":"offline draft"}' },
    ]);
    expect(
      (await native.execute("SELECT value_json FROM prefs WHERE key='language'")).rows,
    ).toEqual([{ value_json: '"zh-CN"' }]);
    expect((await native.execute("SELECT count(*) AS n FROM messages")).rows).toEqual([{ n: 0 }]);
    native.close();
    await f.run(f.recovery.acknowledge);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "healthy" });
    const server = fakeServer("me@example.test", [incoming("fresh", { date: Date.now() })]);
    const mailboxRuntime = ManagedRuntime.make(
      TestMailbox(
        { gmail: server },
        { backgroundFlush: false, imapIdle: false, localDraftQueue: true },
        {},
        Layer.empty,
        {
          database: join(f.root, "mail.db"),
          secrets: { "gmail:me@example.test": "refresh-token" },
        },
      ),
    );
    try {
      await mailboxRuntime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const store = yield* Store;
          yield* mailbox.sync("a");
          expect((yield* store.listThreads({ accountIds: ["a"] })).length).toBe(1);
        }),
      );
      expect(server.pulls[0]).toBe(null);
      expect(server.sent).toEqual([]);
    } finally {
      await mailboxRuntime.dispose();
    }
  });

  it("keeps readable accounts and drafts when an optional profile table is corrupt", async () => {
    const f = await fixture();
    f.failures.corrupt = true;
    f.failures.profile = true;
    const report = await f.run(f.recovery.rebuild);
    expect(report.copied).toBe(3);
    expect(report.skipped).toBe(1);
    const db = await f.run(f.recovery.open());
    expect((await db.execute("SELECT profile_id FROM accounts")).rows).toEqual([
      { profile_id: null },
    ]);
    expect((await db.execute("SELECT id FROM drafts")).rows).toEqual([{ id: "draft" }]);
    db.close();
  });

  it("preserves WAL/SHM/journal and refuses installation after a failed quarantine copy", async () => {
    const f = await fixture();
    const before = readFileSync(join(f.root, "mail.db"));
    f.failures.header = true;
    for (const suffix of ["-wal", "-shm", "-journal"])
      writeFileSync(join(f.root, `mail.db${suffix}`), suffix);
    f.failures.copy = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expectFileBytes(join(f.root, "mail.db"), before);
    f.failures.copy = false;
    const report = await f.run(f.recovery.rebuild);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(readFileSync(join(f.root, `${report.backup}${suffix}`), "utf8")).toBe(suffix);
      expect(existsSync(join(f.root, `mail.db${suffix}`))).toBe(false);
    }
  });

  it("rebuilds an unreadable header without inventing accounts or deleting the preserved file", async () => {
    const f = await fixture();
    const original = new Uint8Array([0, 2, 7, 9]);
    writeFileSync(join(f.root, "mail.db"), original);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "corrupt" });
    const report = await f.run(f.recovery.rebuild);
    expect(report.copied).toBe(0);
    expect(report.skipped).toBeGreaterThan(0);
    expectFileBytes(join(f.root, report.backup), original);
    const db = await f.run(f.recovery.open());
    expect((await db.execute("SELECT count(*) AS n FROM accounts")).rows).toEqual([{ n: 0 }]);
    db.close();
  });

  it("gates openers after an interrupted swap and resumes the prepared replacement", async () => {
    const f = await fixture();
    await crashedSwap(f);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "interrupted" });
    const blocked = await f.run(f.recovery.open().pipe(Effect.result));
    expect(blocked._tag === "Failure" && blocked.failure.reason).toBe("interrupted");
    expect(readdirSync(f.root).some((name) => /^mail\.db\.corrupt-[\w-]+$/.test(name))).toBe(true);
    f.failures.rename = false;
    const report = await f.run(f.recovery.rebuild);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "recovered", report });
  });

  it("finishes a swap interrupted after installation and persists its report until acknowledgment", async () => {
    const f = await fixture();
    f.failures.corrupt = true;
    f.failures.receipt = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "interrupted" });
    expect(readdirSync(f.root).some((name) => /^mail\.db\.recovery-[\w-]+$/.test(name))).toBe(
      false,
    );
    f.failures.receipt = false;
    const report = await f.run(f.recovery.rebuild);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "recovered", report });
    await f.run(f.recovery.acknowledge);
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "healthy" });
  });

  it("rejects recovery while a foreground/headless mailbox is open, and never resets healthy storage", async () => {
    const f = await fixture();
    const db = await f.run(f.recovery.open());
    f.failures.corrupt = true;
    const result = await f.run(f.recovery.rebuild.pipe(Effect.result));
    expect(result._tag === "Failure" && result.failure.reason).toBe("in-use");
    db.close();
    f.failures.corrupt = false;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expect(
      readdirSync(f.root).filter(
        (name) =>
          !["mail.db", "mail.db-wal", "mail.db-shm", "mail.db.foreground-check.json"].includes(
            name,
          ),
      ),
    ).toEqual([]);
  });

  it("refuses invalid interrupted metadata without deleting files outside the sandbox", async () => {
    const f = await fixture();
    const before = readFileSync(join(f.root, "mail.db"));
    writeFileSync(
      join(f.root, "mail.db.recovery-state.json"),
      JSON.stringify({ backup: "../outside", fresh: "mail.db.recovery-id", copied: 0, skipped: 0 }),
    );
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expectFileBytes(join(f.root, "mail.db"), before);
  });
  it("aborts destination IO failures and closes source connections when creating the new DB fails", async () => {
    const f = await fixture();
    const original = readFileSync(join(f.root, "mail.db"));
    f.failures.corrupt = true;
    f.failures.targetOpen = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expect(f.handles.size).toBe(0);
    expectFileBytes(join(f.root, "mail.db"), original);
    f.failures.targetOpen = false;
    f.failures.targetFull = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expect(f.handles.size).toBe(0);
    expectFileBytes(join(f.root, "mail.db"), original);
    expect(existsSync(join(f.root, "mail.db.recovery-state.json"))).toBe(false);
    expectFileBytes(
      join(
        f.root,
        readdirSync(f.root).find((name) => /^mail\.db\.corrupt-[\w-]+$/.test(name)) ?? "missing",
      ),
      original,
    );
  });

  it("reads later rows independently when a corrupt page stops the ordered scan", async () => {
    const f = await fixture();
    const source = opSqliteShim(join(f.root, "mail.db")).open();
    await source.execute(
      "INSERT INTO profiles (id,name,icon,color,position) VALUES ('later','Later','mail','blue',1)",
    );
    source.close();
    f.failures.corrupt = true;
    f.failures.profileScan = true;
    const report = await f.run(f.recovery.rebuild);
    expect(report.skipped).toBeGreaterThan(0);
    const db = await f.run(f.recovery.open());
    expect((await db.execute("SELECT id FROM profiles")).rows).toEqual([{ id: "later" }]);
    expect((await db.execute("SELECT id FROM drafts")).rows).toEqual([{ id: "draft" }]);
    db.close();
  });
  it("reuses one complete quarantine across failed rebuilds and removes fresh files and sidecars", async () => {
    const f = await fixture();
    const original = readFileSync(join(f.root, "mail.db"));
    f.failures.corrupt = true;
    f.failures.targetFull = true;
    for (let retry = 0; retry < 3; retry++) {
      expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
      expect(f.stats.copies).toBe(1);
      expect(
        readdirSync(f.root).filter((name) => /^mail\.db\.corrupt-[\w-]+\.json$/.test(name)),
      ).toHaveLength(1);
      expect(readdirSync(f.root).filter((name) => name.startsWith("mail.db.recovery-"))).toEqual(
        [],
      );
      expectFileBytes(join(f.root, "mail.db"), original);
    }
    f.failures.targetFull = false;
    await f.run(f.recovery.rebuild);
    await f.run(f.recovery.acknowledge);
    f.time.now++;
    f.failures.corrupt = true;
    const second = await f.run(f.recovery.rebuild);
    expect(f.stats.copies).toBe(2);
    expect(
      readdirSync(f.root).filter((name) => /^mail\.db\.corrupt-[\w-]+\.json$/.test(name)),
    ).toEqual([`${second.backup}.json`]);
  });

  it("publishes only complete markers and cleans a torn temporary marker after write failure", async () => {
    const f = await fixture();
    const original = readFileSync(join(f.root, "mail.db"));
    f.failures.corrupt = true;
    f.failures.markerWrite = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expect(existsSync(join(f.root, "mail.db.recovery-state.json"))).toBe(false);
    expect(existsSync(join(f.root, "mail.db.recovery-state.json.tmp"))).toBe(false);
    expectFileBytes(join(f.root, "mail.db"), original);
    expect(readdirSync(f.root).filter((name) => name.startsWith("mail.db.recovery-"))).toEqual([]);
    f.failures.markerWrite = false;
    const report = await f.run(f.recovery.rebuild);
    expect(await f.run(f.recovery.inspect())).toEqual({ kind: "recovered", report });
    expect(f.stats.copies).toBe(1);
  });

  for (const invalid of ["torn", "unreadable", "replacement"] as const) {
    it(`falls back from a ${invalid} marker/replacement to a rebuild without removing preserved files`, async () => {
      const f = await fixture();
      await crashedSwap(f);
      const marker = join(f.root, "mail.db.recovery-state.json");
      if (invalid === "torn") writeFileSync(marker, "{");
      if (invalid === "unreadable") f.failures.markerRead = true;
      if (invalid === "replacement") f.failures.targetCheck = true;
      const preserved = readdirSync(f.root).filter(
        (name) => name.startsWith("mail.db.corrupt-") || /^mail\.db\.recovery-[\w-]+$/.test(name),
      );
      expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "corrupt" });
      expect(existsSync(marker)).toBe(false);
      for (const name of preserved) expect(existsSync(join(f.root, name))).toBe(true);
      f.failures.markerRead = false;
      f.failures.targetCheck = false;
      f.failures.rename = false;
      const report = await f.run(f.recovery.rebuild);
      expect(report.copied).toBe(4);
      expect(f.stats.copies).toBe(1);
      const db = await f.run(f.recovery.open());
      expect((await db.execute("SELECT id FROM drafts")).rows).toEqual([{ id: "draft" }]);
      db.close();
    });
  }

  it("checks once on foreground inspect/open, caches background wakes, and expires or retries failed checks", async () => {
    const f = await fixture();
    const inspection = await f.run(f.recovery.inspect());
    (await f.run(f.recovery.open(inspection))).close();
    (await f.run(f.recovery.open())).close();
    expect(f.stats.checks).toBe(1);
    f.time.now += MOBILE_DATABASE_CHECK_MAX_AGE_MS + 1;
    (await f.run(f.recovery.open())).close();
    expect(f.stats.checks).toBe(2);
    f.failures.corrupt = true;
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "corrupt" });
    expect((await f.run(f.recovery.open().pipe(Effect.result)))._tag).toBe("Failure");
    expect(f.stats.checks).toBe(4);
    f.failures.corrupt = false;
    (await f.run(f.recovery.open())).close();
    expect(f.stats.checks).toBe(5);
    (await f.run(f.recovery.open())).close();
    expect(f.stats.checks).toBe(5);
  });
  it("keeps the fresh DB after a generic swap rename failure and resumes on the next start", async () => {
    const f = await fixture();
    f.failures.corrupt = true;
    f.failures.renameGeneric = true;
    const result = await f.run(f.recovery.rebuild.pipe(Effect.result));
    expect(result._tag === "Failure" && result.failure.reason).toBe("unavailable");
    const prepared = f.interrupted.value;
    if (!prepared) throw new Error("No prepared swap");
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      expect(existsSync(join(f.root, `mail.db${suffix}`))).toBe(false);
    const marker = readFileSync(join(f.root, "mail.db.recovery-state.json"));
    expectFileBytes(prepared.freshPath, prepared.bytes);
    await f.runtime.dispose();
    f.failures.renameGeneric = false;
    const cold = f.createRuntime();
    const recovery = await cold.runPromise(MobileDatabaseRecovery);
    expect(await cold.runPromise(recovery.inspect())).toEqual({ kind: "interrupted" });
    const blocked = await cold.runPromise(recovery.open().pipe(Effect.result));
    expect(blocked._tag === "Failure" && blocked.failure.reason).toBe("interrupted");
    expectFileBytes(join(f.root, "mail.db.recovery-state.json"), marker);
    const report = await cold.runPromise(recovery.rebuild);
    expect(report.copied).toBe(4);
    expect(f.stats.copies).toBe(1);
    const db = await cold.runPromise(recovery.open());
    expect((await db.execute("SELECT id FROM drafts")).rows).toEqual([{ id: "draft" }]);
    db.close();
    expect(existsSync(prepared.freshPath)).toBe(false);
    expect(existsSync(join(f.root, "mail.db.recovery-state.json"))).toBe(false);
  });

  it("deletes repeated partial quarantine copies on a full disk while preserving the live original", async () => {
    const f = await fixture();
    const original = readFileSync(join(f.root, "mail.db"));
    f.failures.corrupt = true;
    f.failures.partialCopy = true;
    for (let retry = 0; retry < 3; retry++) {
      expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
      const copies = readdirSync(f.root).filter(
        (name) => /^mail\.db\.corrupt-[\w-]+$/.test(name) && !/-wal$|-shm$|-journal$/.test(name),
      );
      expect(copies).toHaveLength(0);
      expectFileBytes(join(f.root, "mail.db"), original);
    }
    f.failures.partialCopy = false;
    const report = await f.run(f.recovery.rebuild);
    expectFileBytes(join(f.root, report.backup), original);
    expect(
      readdirSync(f.root).filter(
        (name) => /^mail\.db\.corrupt-[\w-]+$/.test(name) && !/-wal$|-shm$|-journal$/.test(name),
      ),
    ).toEqual([report.backup]);
  });

  it("rebuilds from the only quarantine when the live file and snapshot metadata are lost", async () => {
    const f = await fixture();
    f.failures.corrupt = true;
    const first = await f.run(f.recovery.rebuild);
    rmSync(join(f.root, "mail.db"));
    writeFileSync(join(f.root, `${first.backup}.json`), "{");
    writeFileSync(join(f.root, "mail.db.recovery-state.json"), "{");
    expect(await f.run(f.recovery.inspect({ force: true }))).toEqual({ kind: "corrupt" });
    expect(existsSync(join(f.root, first.backup))).toBe(true);
    const report = await f.run(f.recovery.rebuild);
    expect(report.backup).toBe(first.backup);
    expect(report.copied).toBe(4);
    expect(f.stats.copies).toBe(1);
  });
  for (const metadata of ["missing", "incomplete"] as const) {
    it(`keeps the report's ONLY original backup after install with ${metadata} metadata and an older complete snapshot`, async () => {
      const f = await fixture();
      const original = readFileSync(join(f.root, "mail.db"));
      await crashedSwap(f);
      const marker = Schema.decodeUnknownSync(
        Schema.Struct({
          backup: Schema.String,
          fresh: Schema.String,
          copied: Schema.Int,
          skipped: Schema.Int,
        }),
      )(JSON.parse(readFileSync(join(f.root, "mail.db.recovery-state.json"), "utf8")));
      const older = "mail.db.corrupt-000-older";
      copyFileSync(join(f.root, marker.backup), join(f.root, older));
      const db = opSqliteShim(join(f.root, older)).open();
      await db.execute("DELETE FROM drafts");
      db.close();
      writeFileSync(
        join(f.root, `${older}.json`),
        JSON.stringify({ backup: older, suffixes: [""], createdAt: 0, phase: "installed" }),
      );
      if (metadata === "missing") rmSync(join(f.root, `${marker.backup}.json`));
      else
        writeFileSync(
          join(f.root, `${marker.backup}.json`),
          JSON.stringify({ backup: marker.backup }),
        );
      expect(existsSync(join(f.root, "mail.db"))).toBe(false);
      f.failures.rename = false;
      const report = await f.run(f.recovery.rebuild);
      expect(report.backup).toBe(marker.backup);
      expectFileBytes(join(f.root, report.backup), original);
      expect(existsSync(join(f.root, older))).toBe(false);
      await f.run(f.recovery.acknowledge);
      // A cleanup failure may leave the older snapshot next to the metadata-less current backup.
      copyFileSync(join(f.root, report.backup), join(f.root, older));
      writeFileSync(
        join(f.root, `${older}.json`),
        JSON.stringify({ backup: older, suffixes: [""], createdAt: 0, phase: "installed" }),
      );
      f.failures.corrupt = true;
      f.failures.partialCopy = true;
      expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
      expectFileBytes(join(f.root, report.backup), original);
      f.failures.corrupt = false;
      f.failures.partialCopy = false;
      const recovered = await f.run(f.recovery.open());
      expect((await recovered.execute("SELECT id FROM drafts")).rows).toEqual([{ id: "draft" }]);
      recovered.close();
    });
  }

  it("discards a full-disk partial copy and keeps the newest COMPLETE snapshot", async () => {
    const f = await fixture();
    const live = readFileSync(join(f.root, "mail.db"));
    const backup = "mail.db.corrupt-000-complete";
    copyFileSync(join(f.root, "mail.db"), join(f.root, backup));
    writeFileSync(
      join(f.root, `${backup}.json`),
      JSON.stringify({ backup, suffixes: [""], createdAt: 0, phase: "installed" }),
    );
    f.failures.corrupt = true;
    f.failures.partialCopy = true;
    for (let retry = 0; retry < 3; retry++) {
      expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
      expect(
        readdirSync(f.root).filter(
          (name) => /^mail\.db\.corrupt-[\w-]+$/.test(name) && !/-wal$|-shm$|-journal$/.test(name),
        ),
      ).toEqual([backup]);
      expectFileBytes(join(f.root, backup), live);
      expectFileBytes(join(f.root, "mail.db"), live);
    }
  });

  it("reuses the persisted foreground result on cold headless launch, but checks on foreground and expiry", async () => {
    const f = await fixture();
    const state = await f.run(f.recovery.inspect());
    (await f.run(f.recovery.open(state))).close();
    expect(f.stats.checks).toBe(1);
    const persisted = readFileSync(join(f.root, "mail.db.foreground-check.json"), "utf8");
    expect(JSON.parse(persisted)).toEqual({ result: "ok", at: f.time.now });
    await f.runtime.dispose();
    const cold = f.createRuntime();
    const service = await cold.runPromise(MobileDatabaseRecovery);
    (await cold.runPromise(service.open(undefined))).close();
    expect(f.stats.checks).toBe(1);
    // Reusing a disk record must not pretend a foreground check ran in this process.
    await cold.runPromise(service.inspect());
    expect(f.stats.checks).toBe(2);
    await cold.dispose();
    f.time.now += MOBILE_DATABASE_CHECK_MAX_AGE_MS + 1;
    const expired = f.createRuntime();
    const expiredService = await expired.runPromise(MobileDatabaseRecovery);
    (await expired.runPromise(expiredService.open(undefined))).close();
    expect(f.stats.checks).toBe(3);
    // Background verification does not extend the last foreground timestamp.
    expect(readFileSync(join(f.root, "mail.db.foreground-check.json"), "utf8")).toBe(persisted);
  });

  for (const failed of ["corrupt", "unavailable"] as const) {
    it(`checks again on cold headless launch after a ${failed} foreground result`, async () => {
      const f = await fixture();
      await f.run(f.recovery.inspect());
      f.time.now++;
      if (failed === "corrupt") f.failures.corrupt = true;
      else f.failures.diskFull = true;
      const result = await f.run(f.recovery.inspect({ force: true }).pipe(Effect.result));
      expect(result._tag).toBe(failed === "corrupt" ? "Success" : "Failure");
      expect(
        JSON.parse(readFileSync(join(f.root, "mail.db.foreground-check.json"), "utf8")),
      ).toEqual({ result: failed, at: f.time.now });
      await f.runtime.dispose();
      f.failures.corrupt = false;
      f.failures.diskFull = false;
      const cold = f.createRuntime();
      const service = await cold.runPromise(MobileDatabaseRecovery);
      (await cold.runPromise(service.open(undefined))).close();
      expect(f.stats.checks).toBe(3);
    });
  }

  for (const transient of ["open", "query"] as const) {
    it(`preserves a prepared replacement and retries a transient ${transient} error`, async () => {
      const f = await fixture();
      await crashedSwap(f);
      const markerFile = join(f.root, "mail.db.recovery-state.json");
      const marker = readFileSync(markerFile);
      const prepared = f.interrupted.value;
      if (!prepared) throw new Error("No prepared swap");
      if (transient === "open") f.failures.replacementOpen = true;
      else f.failures.replacementQuery = true;
      const result = await f.run(f.recovery.inspect({ force: true }).pipe(Effect.result));
      expect(result._tag === "Failure" && result.failure.reason).toBe("unavailable");
      expectFileBytes(markerFile, marker);
      expectFileBytes(prepared.freshPath, prepared.bytes);
      expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
      expectFileBytes(markerFile, marker);
      expectFileBytes(prepared.freshPath, prepared.bytes);
      f.failures.replacementOpen = false;
      f.failures.replacementQuery = false;
      f.failures.rename = false;
      const report = await f.run(f.recovery.rebuild);
      expect(report.copied).toBe(4);
      expect(f.stats.copies).toBe(1);
    });
  }
  it("checks on cold headless launch when the persisted foreground record is torn or from the future", async () => {
    const f = await fixture();
    await f.run(f.recovery.inspect());
    await f.runtime.dispose();
    const cache = join(f.root, "mail.db.foreground-check.json");
    for (const record of ["{", JSON.stringify({ result: "ok", at: f.time.now + 1000 })]) {
      writeFileSync(cache, record);
      const cold = f.createRuntime();
      const service = await cold.runPromise(MobileDatabaseRecovery);
      (await cold.runPromise(service.open(undefined))).close();
      await cold.dispose();
    }
    expect(f.stats.checks).toBe(3);
  });
  it("cannot reuse an old success after a failed foreground check when persisting its result hits a full disk", async () => {
    const f = await fixture();
    await f.run(f.recovery.inspect());
    const cache = join(f.root, "mail.db.foreground-check.json");
    expect(existsSync(cache)).toBe(true);
    f.failures.foregroundWrite = true;
    f.failures.diskFull = true;
    expect((await f.run(f.recovery.inspect({ force: true }).pipe(Effect.result)))._tag).toBe(
      "Failure",
    );
    expect(existsSync(cache)).toBe(false);
    await f.runtime.dispose();
    f.failures.diskFull = false;
    const cold = f.createRuntime();
    const service = await cold.runPromise(MobileDatabaseRecovery);
    (await cold.runPromise(service.open(undefined))).close();
    expect(f.stats.checks).toBe(3);
    // Optional cache writes may fail without blocking a DB that was actually verified.
    expect(await cold.runPromise(service.inspect())).toEqual({ kind: "healthy" });
    expect(existsSync(cache)).toBe(false);
  });
  it("ranks the newest preserved current-original snapshot above the older reported backup after an interrupted prune", async () => {
    const f = await fixture();
    f.failures.corrupt = true;
    const old = await f.run(f.recovery.rebuild);
    await f.run(f.recovery.acknowledge);
    const db = opSqliteShim(join(f.root, "mail.db")).open();
    await db.execute("UPDATE drafts SET message_json=? WHERE id='draft'", [
      '{"subject":"current original"}',
    ]);
    db.close();
    const newest = "mail.db.corrupt-2000-current";
    const earlier = "mail.db.corrupt-1500-earlier";
    const current = readFileSync(join(f.root, "mail.db"));
    // Both complete copies coexist with the previous receipt when pruning is interrupted.
    for (const [backup, createdAt] of [
      [earlier, 1500],
      [newest, 2000],
    ] as const) {
      copyFileSync(join(f.root, "mail.db"), join(f.root, backup));
      writeFileSync(
        join(f.root, `${backup}.json`),
        JSON.stringify({ backup, suffixes: [""], createdAt, phase: "preserved" }),
      );
    }
    const copies = f.stats.copies;
    f.time.now = 3000;
    f.failures.targetOpen = true;
    expect((await f.run(f.recovery.rebuild.pipe(Effect.result)))._tag).toBe("Failure");
    expectFileBytes(join(f.root, newest), current);
    expect(existsSync(join(f.root, old.backup))).toBe(false);
    expect(existsSync(join(f.root, earlier))).toBe(false);
    expect(f.stats.copies).toBe(copies);
    f.failures.targetOpen = false;
    const report = await f.run(f.recovery.rebuild);
    expect(report.backup).toBe(newest);
    expect(f.stats.copies).toBe(copies);
    const recovered = await f.run(f.recovery.open());
    expect((await recovered.execute("SELECT message_json FROM drafts")).rows).toEqual([
      { message_json: '{"subject":"current original"}' },
    ]);
    recovered.close();
  });
});
