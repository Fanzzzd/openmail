import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { acquireDatabaseAccess, DatabaseInUseError } from "./database-access.js";

export class InterruptedRecoveryError extends Error {
  constructor(readonly backups: readonly string[]) {
    super(
      "Database recovery was interrupted. A preserved database must be restored before OpenMail can open it.",
    );
    this.name = "InterruptedRecoveryError";
  }
}
const Manifest = Schema.Struct({
  backup: Schema.String,
  fresh: Schema.String,
  device: Schema.Number,
  inode: Schema.Number,
});
const namesIn = (file: string) => (existsSync(dirname(file)) ? readdirSync(dirname(file)) : []);
const sameFile = (a: string, b: string) => {
  const x = statSync(a);
  const y = statSync(b);
  return x.dev === y.dev && x.ino === y.ino;
};
const backupBases = (file: string, names: readonly string[]) =>
  [
    ...new Set(
      names
        .filter((name) => name.startsWith(`${basename(file)}.corrupt-`))
        .map((name) => name.replace(/\.preserved$/u, "").replace(/-(?:wal|shm|journal)$/u, "")),
    ),
  ].map((name) => join(dirname(file), name));
export function hasRecoveryArtifacts(file: string) {
  const names = namesIn(file);
  return names.some((name) => name.startsWith(`${basename(file)}.recovery-`));
}

/** Called only under the exclusive access lock, before any mail.db connection is opened. */
export function cleanInterruptedRecovery(file: string) {
  if (!hasRecoveryArtifacts(file)) return;
  const names = namesIn(file);
  const backups = backupBases(file, names);
  if (!existsSync(file)) {
    const preserved = backups.filter((path) => existsSync(path) || existsSync(`${path}.preserved`));
    if (!preserved.length)
      preserved.push(
        ...names
          .filter(
            (name) =>
              name.startsWith(`${basename(file)}.recovery-`) &&
              !name.endsWith("-journal") &&
              !name.endsWith(".json"),
          )
          .map((name) => join(dirname(file), name)),
      );
    if (preserved.length) throw new InterruptedRecoveryError(preserved);
    if (names.some((name) => name.startsWith(`${basename(file)}.recovery-`)))
      throw new InterruptedRecoveryError(backups);
    return;
  }
  const marker = `${file}.recovery-state.json`;
  let current: typeof Manifest.Type | undefined;
  if (existsSync(marker)) {
    try {
      current = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(marker, "utf8")));
      if (
        basename(current.backup) !== current.backup ||
        !current.backup.startsWith(`${basename(file)}.corrupt-`) ||
        basename(current.fresh) !== current.fresh ||
        !current.fresh.startsWith(`${basename(file)}.recovery-`)
      )
        throw new Error("Invalid recovery names");
    } catch {
      throw new InterruptedRecoveryError(backups);
    }
  }
  const affected = current
    ? [join(dirname(file), current.backup)]
    : backups.filter((backup) => existsSync(backup) && sameFile(file, backup));
  for (const backup of affected) {
    const live = statSync(file);
    const originalStillLive = current
      ? live.dev === current.device && live.ino === current.inode
      : sameFile(file, backup);
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      if (existsSync(`${backup}${suffix}.preserved`))
        renameSync(`${backup}${suffix}.preserved`, `${backup}${suffix}`);
    if (originalStillLive) {
      for (const suffix of ["-wal", "-shm", "-journal"])
        if (existsSync(`${backup}${suffix}`))
          copyFileSync(`${backup}${suffix}`, `${file}${suffix}`);
    } else {
      // New core connections cannot open until this marker is handled. These are never fresh WALs.
      for (const suffix of ["-wal", "-shm", "-journal"])
        rmSync(`${file}${suffix}`, { force: true });
      let verify: DatabaseSync | undefined;
      try {
        verify = new DatabaseSync(file, { readOnly: true });
        if (verify.prepare("PRAGMA quick_check").get()?.quick_check !== "ok")
          throw new Error("Incomplete replacement");
      } catch {
        throw new InterruptedRecoveryError([backup]);
      } finally {
        verify?.close();
      }
    }
  }
  for (const name of names)
    if (name.startsWith(`${basename(file)}.recovery-`))
      rmSync(join(dirname(file), name), { force: true });
}

export function prepareDatabaseStartup(directory: string) {
  const file = join(directory, "mail.db");
  if (!hasRecoveryArtifacts(file)) return;
  const access = acquireDatabaseAccess(file, "exclusive");
  try {
    cleanInterruptedRecovery(file);
  } finally {
    access.release();
  }
}

/** All desktop/CLI/MCP database layers hold this shared lease until their SQLite connection closes. */
export function openDatabaseAccess(file: string) {
  const deadline = Date.now() + 250;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const access = acquireDatabaseAccess(file, "shared");
    try {
      if (!hasRecoveryArtifacts(file)) return access;
    } catch (error) {
      access.release();
      throw error;
    }
    access.release();
    try {
      const exclusive = acquireDatabaseAccess(file, "exclusive");
      try {
        cleanInterruptedRecovery(file);
      } finally {
        exclusive.release();
      }
    } catch (error) {
      if (!(error instanceof DatabaseInUseError)) throw error;
      // Another opener may have completed startup cleanup while we were upgrading the lease.
      if (!hasRecoveryArtifacts(file)) continue;
      if (Date.now() >= deadline) throw new DatabaseInUseError("shared");
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}
