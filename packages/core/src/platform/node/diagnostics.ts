import { SyncCrashDiagnostic } from "../../sync-crash.js";
export { SyncCrashDiagnostic } from "../../sync-crash.js";
import { SyncResetDiagnostic } from "../../sync-reset.js";
export { SyncResetDiagnostic } from "../../sync-reset.js";
import { ProviderDiagnostic } from "../../provider-diagnostics.js";
export { ProviderDiagnostic } from "../../provider-diagnostics.js";
import { ReauthDiagnostic } from "../../reauth.js";
export { ReauthDiagnostic } from "../../reauth.js";
import { SyncFailedDiagnostic } from "../../sync-failure.js";
export { SyncFailedDiagnostic } from "../../sync-failure.js";
import {
  databaseQuickCheck,
  databaseQuickCheckInWorker,
  rebuildCorruptDatabase,
  type CacheResetResult,
} from "./database-recovery.js";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import { DatabaseTooNewError, MIGRATIONS } from "../../db/db.js";

const DiagnosticEvent = Schema.Literals([
  "startup",
  "startup-failed",
  "renderer-crash",
  "abnormal-exit",
  "cache-reset",
  "integrity-ok",
  "integrity-failed",
  "runtime-error",
  "runtime-warning",
  "provider-failure",
  "sync-reset",
  "rpc-auth-failure",
  "rpc-failure",
  "reauth",
]);
export type DiagnosticEvent = typeof DiagnosticEvent.Type;
const RuntimeReason = Schema.Literals([
  "header-backfill-failed",
  "history-backfill-failed",
  "sync-failed",
  "sync-crashed",
  "inbox-poll-failed",
  "flush-failed",
  "media-index-failed",
  "attachment-cache-unavailable",
  "attachment-cleanup-failed",
  "uncaught-exception",
  "unhandled-rejection",
  "unclassified",
]);
const runtimeReasons: Readonly<Record<string, typeof RuntimeReason.Type>> = {
  "Header backfill failed": "header-backfill-failed",
  "backfill failed": "history-backfill-failed",
  "inbox poll failed": "inbox-poll-failed",
  "flush failed": "flush-failed",
  "Media indexing batch failed": "media-index-failed",
  "Attachment cache unavailable": "attachment-cache-unavailable",
  "Attachment drag cleanup failed": "attachment-cleanup-failed",
  "Attachment temp cleanup failed": "attachment-cleanup-failed",
  "Open With cleanup failed": "attachment-cleanup-failed",
};
/** Only exact fixed log messages can classify a runtime event; never serialize error text. */
export function runtimeDiagnosticReason(messages: readonly unknown[]): typeof RuntimeReason.Type {
  for (const message of messages) {
    if (typeof message !== "string") continue;
    const reason = Object.hasOwn(runtimeReasons, message) ? runtimeReasons[message] : undefined;
    if (reason) return reason;
  }
  return "unclassified";
}
const Crash = Schema.Struct({
  at: Schema.Number,
  kind: Schema.Literals(["renderer-crash", "abnormal-exit"]),
  code: Schema.Number,
});
const Health = Schema.Struct({
  running: Schema.Boolean,
  startedAt: Schema.Number,
  crashes: Schema.Array(Crash),
  pendingReport: Schema.optionalKey(Schema.Boolean),
  reportCrashes: Schema.optionalKey(Schema.Array(Crash)),
});
const EMPTY_HEALTH: typeof Health.Type = { running: false, startedAt: 0, crashes: [] };
export const CRASH_WINDOW_MS = 5 * 60_000;

/** Fixed fields only. Free text, causes, stack traces and nested payloads are never serialized. */
export function diagnosticRecord(event: unknown, data: unknown = {}, at = Date.now()) {
  const decoded = Schema.decodeUnknownOption(DiagnosticEvent)(event);
  const fields = typeof data === "object" && data !== null ? data : {};
  const code =
    "code" in fields && typeof fields.code === "number" && Number.isFinite(fields.code)
      ? Math.trunc(fields.code)
      : undefined;
  const account =
    "account" in fields && typeof fields.account === "string"
      ? createHash("sha256").update(fields.account.toLowerCase()).digest("hex").slice(0, 16)
      : undefined;
  const provider = Schema.decodeUnknownOption(ProviderDiagnostic)(data);
  const reset = Schema.decodeUnknownOption(SyncResetDiagnostic)(data);
  const crash = Schema.decodeUnknownOption(
    Schema.Struct({
      ...SyncCrashDiagnostic.fields,
      _tag: Schema.optionalKey(SyncCrashDiagnostic.fields._tag),
    }),
  )(data);
  const reason = Schema.decodeUnknownOption(RuntimeReason)(
    "reason" in fields ? fields.reason : undefined,
  );
  if (event === "sync-reset" && reset._tag === "Some") {
    const value = reset.value;
    return {
      at,
      event,
      _tag: value._tag,
      provider: value.provider,
      phase: value.phase,
      accountHash: /^[a-f0-9]{16}$/.test(value.accountHash) ? value.accountHash : undefined,
      folderHash: /^[a-f0-9]{16}$/.test(value.folderHash) ? value.folderHash : undefined,
      ...Object.fromEntries(
        ["listed", "kept", "local", "candidates", "verified", "incomplete", "deferred"].flatMap(
          (key) => {
            const count = key in value ? Reflect.get(value, key) : undefined;
            return typeof count === "number" && Number.isFinite(count) && count >= 0
              ? [[key, Math.trunc(count)]]
              : [];
          },
        ),
      ),
    };
  }
  const syncFailed = Schema.decodeUnknownOption(SyncFailedDiagnostic)(data);
  if (event === "runtime-warning" && syncFailed._tag === "Some") {
    const value = syncFailed.value;
    return {
      at,
      event,
      _tag: value._tag,
      reason: value.reason,
      provider: value.provider,
      failure: value.failure,
      scope: value.scope,
      ...(value.status !== undefined && Number.isFinite(value.status)
        ? { status: Math.trunc(value.status) }
        : {}),
      accountHash: /^[a-f0-9]{16}$/.test(value.accountHash) ? value.accountHash : undefined,
    };
  }
  const reauth = Schema.decodeUnknownOption(ReauthDiagnostic)(data);
  if (event === "reauth" && reauth._tag === "Some")
    return {
      at,
      event,
      provider: reauth.value.provider,
      reason: reauth.value.reason,
      accountHash: /^[a-f0-9]{16}$/.test(reauth.value.accountHash)
        ? reauth.value.accountHash
        : undefined,
    };
  const isRpcFailure = event === "rpc-failure" || event === "rpc-auth-failure";
  const rpc =
    isRpcFailure &&
    "rpc" in fields &&
    typeof fields.rpc === "string" &&
    /^[A-Z][A-Za-z0-9]{0,127}$/.test(fields.rpc)
      ? fields.rpc
      : undefined;
  if (isRpcFailure) return { at, event, ...(rpc === undefined ? {} : { rpc }) };
  return {
    at,
    event: decoded._tag === "Some" ? decoded.value : "runtime-error",
    ...(event === "runtime-warning" || event === "runtime-error"
      ? { reason: reason._tag === "Some" ? reason.value : "unclassified" }
      : {}),
    ...(crash._tag === "Some"
      ? { phase: crash.value.phase, causeKind: crash.value.causeKind }
      : {}),
    ...(code === undefined ? {} : { code }),
    ...(account === undefined ? {} : { accountHash: account }),
    ...(provider._tag === "Some"
      ? {
          _tag: provider.value._tag,
          provider: provider.value.provider,
          method: provider.value.method,
          endpoint: provider.value.endpoint,
          ...(provider.value.operation ? { operation: provider.value.operation } : {}),
          ...(provider.value.errorCode ? { errorCode: provider.value.errorCode } : {}),
          ...(provider.value.status === undefined ? {} : { status: provider.value.status }),
          ...(provider.value.failure === undefined ? {} : { failure: provider.value.failure }),
          accountHash: /^[a-f0-9]{16}$/.test(provider.value.accountHash)
            ? provider.value.accountHash
            : undefined,
        }
      : {}),
  };
}

export function createLocalDiagnostics(
  directory: string,
  options: { maxBytes?: number; archives?: number; now?: () => number } = {},
) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    /* Recovery can still run without diagnostic storage. */
  }
  const file = join(directory, "diagnostics.jsonl");
  const stateFile = join(directory, "health.json");
  const maxBytes = Math.max(512, options.maxBytes ?? 256 * 1024);
  const archives = Math.max(1, Math.min(5, options.archives ?? 3));
  const now = options.now ?? Date.now;
  let health: typeof Health.Type = EMPTY_HEALTH;
  try {
    health = Schema.decodeUnknownSync(Health)(JSON.parse(readFileSync(stateFile, "utf8")));
  } catch {
    /* A missing or malformed marker is not evidence of a crash. */
  }
  const persist = () => {
    try {
      writeFileSync(`${stateFile}.tmp`, JSON.stringify(health), { mode: 0o600 });
      renameSync(`${stateFile}.tmp`, stateFile);
    } catch {
      /* Disk full/read-only storage must not prevent startup or recovery. */
    }
  };
  const record = (event: DiagnosticEvent, data: unknown = {}) => {
    try {
      const line = `${JSON.stringify(diagnosticRecord(event, data, now()))}\n`;
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        for (let i = archives; i > 1; i--)
          if (existsSync(`${file}.${i - 1}`)) renameSync(`${file}.${i - 1}`, `${file}.${i}`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
      chmodSync(file, 0o600);
    } catch {
      /* Logging failure must not crash the app. */
    }
  };
  const crash = (kind: (typeof Crash.Type)["kind"], code = 0) => {
    const at = now();
    health = {
      ...health,
      crashes: [...health.crashes, { at, kind, code }].slice(-20),
      reportCrashes: [...(health.reportCrashes ?? health.crashes), { at, kind, code }].slice(-20),
      pendingReport: true,
    };
    persist();
    record(kind, { code });
    return health.crashes.filter((c) => at - c.at <= CRASH_WINDOW_MS).length >= 3;
  };
  return {
    file,
    record,
    begin: () => {
      const abnormalExit = health.running;
      if (abnormalExit) crash("abnormal-exit");
      health = { ...health, running: true, startedAt: now() };
      persist();
      record("startup");
      return {
        abnormalExit,
        safeMode: health.crashes.filter((c) => now() - c.at <= CRASH_WINDOW_MS).length >= 3,
        crashed: health.pendingReport ?? health.crashes.length > 0,
      };
    },
    crash,
    finish: () => {
      health = { ...health, running: false };
      persist();
    },
    resetCrashHistory: () => {
      health = { ...health, reportCrashes: health.reportCrashes ?? health.crashes, crashes: [] };
      persist();
    },
    acknowledge: () => {
      health = { ...health, pendingReport: false };
      persist();
    },
    preview: (crashOnly = false) => {
      // Re-encode stored records too: a tampered or older file cannot introduce free text.
      const entries: string[] = [];
      if (!crashOnly)
        for (let i = archives; i >= 0; i--) {
          const candidate = i ? `${file}.${i}` : file;
          if (!existsSync(candidate) || statSync(candidate).size > maxBytes) continue;
          for (const line of readFileSync(candidate, "utf8").split("\n")) {
            try {
              const value: unknown = JSON.parse(line);
              if (typeof value === "object" && value !== null && "event" in value) {
                const at =
                  "at" in value && typeof value.at === "number" && Number.isFinite(value.at)
                    ? value.at
                    : 0;
                entries.push(JSON.stringify(diagnosticRecord(value.event, value, at)));
              }
            } catch {
              /* Ignore incomplete lines. */
            }
          }
        }
      for (const c of health.reportCrashes ?? health.crashes)
        entries.push(JSON.stringify(diagnosticRecord(c.kind, { code: c.code }, c.at)));
      return entries.join("\n");
    },
  };
}

export type IntegrityResult = "ok" | "corrupt" | "unavailable";
/** Preflight before the mailbox opens the file. No SQLite text leaves this boundary. */
/**
 * The schema version of a database a newer OpenMail migrated, or undefined. Read-only; an
 * unreadable file is left to the integrity check.
 */
export function newerDatabaseVersion(directory: string): number | undefined {
  const file = join(directory, "mail.db");
  if (!existsSync(file)) return undefined;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare("PRAGMA user_version").get();
      const version = row && typeof row.user_version === "number" ? row.user_version : 0;
      return version > MIGRATIONS.length ? version : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export function checkLocalDatabase(directory: string): IntegrityResult {
  return databaseQuickCheck(join(directory, "mail.db"));
}

/** Startup check after an abnormal exit; the worker leaves the main thread free to paint. */
export function checkLocalDatabaseInWorker(
  directory: string,
  options?: Parameters<typeof databaseQuickCheckInWorker>[1],
): Promise<IntegrityResult> {
  return databaseQuickCheckInWorker(join(directory, "mail.db"), options);
}

/** Cache reset preserves accounts, preferences, drafts, queued user changes and keychain items. */
export function resetLocalCache(directory: string): CacheResetResult {
  const file = join(directory, "mail.db");
  if (!existsSync(file)) return { kind: "reset" };
  // Rebuilding would write this version's schema into a newer OpenMail's database.
  const newer = newerDatabaseVersion(directory);
  if (newer !== undefined) throw new DatabaseTooNewError(newer);
  const integrity = checkLocalDatabase(directory);
  if (integrity === "corrupt") return rebuildCorruptDatabase(directory);
  if (integrity !== "ok") throw new Error("Local database unavailable");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;");
    const NamedRows = Schema.Array(Schema.Struct({ name: Schema.String }));
    const tables = new Set(
      Schema.decodeUnknownSync(NamedRows)(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ).map((row) => row.name),
    );
    if (tables.has("messages_fts"))
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    if (tables.has("contact_candidates_fts"))
      db.exec("INSERT INTO contact_candidates_fts(contact_candidates_fts) VALUES ('rebuild')");
    if (tables.has("contact_organizations_fts"))
      db.exec(
        "INSERT INTO contact_organizations_fts(contact_organizations_fts) VALUES ('rebuild')",
      );
    if (tables.has("derived_fts"))
      db.exec("INSERT INTO derived_fts(derived_fts) VALUES ('rebuild')");
    if (tables.has("contact_completion_fts"))
      db.exec("INSERT INTO contact_completion_fts(contact_completion_fts) VALUES ('delete-all')");
    // Recovery precedes migrations, so older caches may lack some of these tables.
    for (const table of [
      "messages",
      "message_badges",
      "message_search_meta",
      "labels",
      "backfill",
      "cache_maintenance",
      "server_contacts",
      "contact_candidates",
      "contact_organizations",
      "contact_groups",
      "contact_photos",
      "sent_recipients",
      "contact_sync",
      "seen_incoming",
      "incoming_state",
      "mailed_addresses",
    ]) {
      if (tables.has(table)) db.exec(`DELETE FROM ${table}`);
    }
    if (tables.has("accounts")) {
      const columns = new Set(
        Schema.decodeUnknownSync(NamedRows)(db.prepare("PRAGMA table_info(accounts)").all()).map(
          (row) => row.name,
        ),
      );
      const resets = ["sync_cursor", "last_synced_at", "last_sync_error"]
        .filter((name) => columns.has(name))
        .map((name) => `${name}=NULL`);
      if (resets.length) db.exec(`UPDATE accounts SET ${resets.join(",")}`);
    }
    if (tables.has("messages_fts"))
      db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
    if (tables.has("contact_candidates_fts"))
      db.exec("INSERT INTO contact_candidates_fts(contact_candidates_fts) VALUES ('rebuild')");
    if (tables.has("contact_organizations_fts"))
      db.exec(
        "INSERT INTO contact_organizations_fts(contact_organizations_fts) VALUES ('rebuild')",
      );
    if (tables.has("derived_fts"))
      db.exec("INSERT INTO derived_fts(derived_fts) VALUES ('rebuild')");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
  if (checkLocalDatabase(directory) !== "ok")
    throw new Error("Reset database failed integrity check");
  return { kind: "reset" };
}
