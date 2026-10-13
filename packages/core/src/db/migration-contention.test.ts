import { applyNativeMigration } from "../platform/node/migrations.js";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../platform/node/db.js";

function opener(file: string, hold: boolean) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../platform/node/fixtures/migration-open.mjs", import.meta.url)),
      file,
      hold ? "hold" : "open",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
    for (const [message, waiter] of waiters) {
      if (stdout.includes(message)) {
        waiters.delete(message);
        waiter.resolve();
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      const error = new Error(
        `Database opener exited ${code} before its expected output: ${stderr}`,
      );
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
      if (code === 0) resolve();
      else reject(error);
    });
  });
  void finished.catch(() => {
    /* The caller observes failures when awaiting finished. */
  });
  const waitFor = (message: string) => {
    if (stdout.includes(message)) return Promise.resolve();
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(new Error(`Database opener exited before ${message}: ${stderr}`));
    return new Promise<void>((resolve, reject) => {
      waiters.set(message, { resolve, reject });
    });
  };
  return { child, finished, waitFor, output: () => stdout };
}

it("concurrent processes wait beyond five seconds for an old database migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmail-migration-wait-"));
  const file = join(directory, "mail.db");
  const children: ReturnType<typeof opener>[] = [];
  try {
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA journal_mode=WAL");
      for (const migration of MIGRATIONS.slice(0, -1)) applyNativeMigration(db, migration);
      db.exec(`PRAGMA user_version=${MIGRATIONS.length - 1}`);
    } finally {
      db.close();
    }
    const first = opener(file, true);
    children.push(first);
    await first.waitFor("migration-lock-held");
    const second = opener(file, false);
    children.push(second);
    await second.waitFor("Waiting for another process to finish database migrations");
    first.child.stdin.end("release\n");
    await Promise.all(children.map((process) => process.finished));
    expect(first.output()).toContain(`ready:${MIGRATIONS.length}`);
    expect(second.output()).toContain("Waiting for another process to finish database migrations");
    expect(second.output()).toContain(`ready:${MIGRATIONS.length}`);
    const migrated = new DatabaseSync(file);
    try {
      expect(migrated.prepare("PRAGMA user_version").get()).toMatchObject({
        user_version: MIGRATIONS.length,
      });
      expect(
        migrated.prepare("SELECT name FROM sqlite_master WHERE name='message_search_meta'").all(),
      ).toHaveLength(1);
    } finally {
      migrated.close();
    }
  } finally {
    for (const process of children) if (process.child.exitCode === null) process.child.kill();
    await Promise.allSettled(children.map((process) => process.finished));
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);
