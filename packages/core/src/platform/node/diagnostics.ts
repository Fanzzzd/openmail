import { SyncCrashDiagnostic } from "../../sync/sync-crash.js";
export { SyncCrashDiagnostic } from "../../sync/sync-crash.js";
import { SyncResetDiagnostic } from "../../sync/sync-reset.js";
export { SyncResetDiagnostic } from "../../sync/sync-reset.js";
import { ProviderDiagnostic } from "../../providers/provider-diagnostics.js";
export { ProviderDiagnostic } from "../../providers/provider-diagnostics.js";
import { ReauthDiagnostic } from "../../providers/reauth.js";
export { ReauthDiagnostic } from "../../providers/reauth.js";
import { SyncFailedDiagnostic } from "../../sync/sync-failure.js";
export { SyncFailedDiagnostic } from "../../sync/sync-failure.js";
import {
  databaseQuickCheck,
  databaseQuickCheckInWorker,
  rebuildCorruptDatabase,
  type CacheResetResult,
} from "./database-recovery.js";
import { createHash, randomBytes } from "node:crypto";
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
import { DatabaseTooNewError } from "../../db/migrate.js";
import { MIGRATIONS } from "../../db/migrations.js";
import { LogCode, keyedDiagnosticHash, logCodeOf } from "../../domain/diagnostic-log.js";
export { PlannerStatsSkippedDiagnostic } from "../../domain/diagnostic-log.js";
import { AccountDiagnostics } from "../../domain/diagnostics-state.js";

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
/** The code a log site attached (see diagnostic-log.ts), or a fixed process-level reason. */
const RuntimeReason = Schema.Literals([
  ...LogCode.literals,
  "uncaught-exception",
  "unhandled-rejection",
  "unclassified",
]);
export type RuntimeReason = typeof RuntimeReason.Type;
/** The reason for a runtime log line: its attached code, never its message text. */
export function runtimeDiagnosticReason(annotations: unknown): RuntimeReason {
  return logCodeOf(annotations) ?? "unclassified";
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

/** A version or build string: no spaces, slashes or @, so it cannot carry a path or address. */
const VersionText = Schema.String.check(Schema.isPattern(/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/));
const versionText = (value: unknown) => {
  const decoded = Schema.decodeUnknownOption(VersionText)(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};

/**
 * Error classes an rpc-failure record may name for a defect. A defect of any other class logs
 * as "Other". A defect's message never reaches the log.
 */
export const RPC_DEFECT_CLASSES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "SqliteError",
  "SqlError",
  "SchemaError",
  "DOMException",
  "AbortError",
  "Other",
]);
/** How a request failed: a typed error, a defect, or an interruption the client did not ask for. */
export const RpcFailureKind = Schema.Literals(["failure", "defect", "interrupt"]);
export type RpcFailureKind = typeof RpcFailureKind.Type;
/** A typed error's _tag or a class name: an identifier, never text from the error. */
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

/** A 16-digit hex hash, or undefined for anything else. */
const hashField = (value: string | undefined) =>
  value !== undefined && /^[a-f0-9]{16}$/.test(value) ? value : undefined;

/** Fixed fields only. Free text, causes, stack traces and nested payloads are never serialized. */
export function diagnosticRecord(event: unknown, data: unknown = {}, at = Date.now()) {
  const decoded = Schema.decodeUnknownOption(DiagnosticEvent)(event);
  const fields = typeof data === "object" && data !== null ? data : {};
  const code =
    "code" in fields && typeof fields.code === "number" && Number.isFinite(fields.code)
      ? Math.trunc(fields.code)
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
      accountHash: hashField(value.accountHash),
      folderHash: hashField(value.folderHash),
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
      accountHash: hashField(value.accountHash),
    };
  }
  const reauth = Schema.decodeUnknownOption(ReauthDiagnostic)(data);
  if (event === "reauth" && reauth._tag === "Some")
    return {
      at,
      event,
      provider: reauth.value.provider,
      reason: reauth.value.reason,
      accountHash: hashField(reauth.value.accountHash),
    };
  const isRpcFailure = event === "rpc-failure" || event === "rpc-auth-failure";
  const rpc =
    isRpcFailure &&
    "rpc" in fields &&
    typeof fields.rpc === "string" &&
    /^[A-Z][A-Za-z0-9]{0,127}$/.test(fields.rpc)
      ? fields.rpc
      : undefined;
  if (event === "rpc-failure") {
    const kind = Schema.decodeUnknownOption(RpcFailureKind)(
      "kind" in fields ? fields.kind : undefined,
    );
    const error = "error" in fields && typeof fields.error === "string" ? fields.error : "";
    const named =
      kind._tag === "Some" &&
      ((kind.value === "failure" && ERROR_NAME.test(error)) ||
        (kind.value === "defect" && RPC_DEFECT_CLASSES.has(error)));
    return {
      at,
      event,
      ...(rpc === undefined ? {} : { rpc }),
      ...(kind._tag === "Some" ? { kind: kind.value } : {}),
      ...(named ? { error } : {}),
    };
  }
  if (isRpcFailure) return { at, event, ...(rpc === undefined ? {} : { rpc }) };
  const appVersion =
    event === "startup" && "appVersion" in fields ? versionText(fields.appVersion) : undefined;
  return {
    at,
    event: decoded._tag === "Some" ? decoded.value : "runtime-error",
    ...(event === "runtime-warning" || event === "runtime-error"
      ? { reason: reason._tag === "Some" ? reason.value : "unclassified" }
      : {}),
    ...(crash._tag === "Some"
      ? { phase: crash.value.phase, causeKind: crash.value.causeKind }
      : {}),
    ...(appVersion === undefined ? {} : { appVersion }),
    ...(code === undefined ? {} : { code }),
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
          accountHash: hashField(provider.value.accountHash),
        }
      : {}),
  };
}

const Platform = Schema.Literals(["darwin", "linux", "win32"]);
const Arch = Schema.Literals(["arm64", "x64"]);
const MAX_SNAPSHOT_ACCOUNTS = 50;

/**
 * The first line of a diagnostics export: build, runtime, schema version and per-account sync
 * state. Fixed fields only. Accounts appear by list position, never by address or hash.
 */
export function diagnosticSnapshot(environment: unknown, state: unknown, at = Date.now()) {
  const env = typeof environment === "object" && environment !== null ? environment : {};
  const field = (key: string) => (key in env ? Reflect.get(env, key) : undefined);
  const enumField = <A extends string>(schema: Schema.Codec<A, string>, key: string) => {
    const decoded = Schema.decodeUnknownOption(schema)(field(key));
    return decoded._tag === "Some" ? decoded.value : undefined;
  };
  const fields = typeof state === "object" && state !== null ? state : {};
  const version = "schemaVersion" in fields ? fields.schemaVersion : undefined;
  const statsPresent = "plannerStatsPresent" in fields ? fields.plannerStatsPresent : undefined;
  const rawAccounts =
    "accounts" in fields && Array.isArray(fields.accounts)
      ? fields.accounts.slice(0, MAX_SNAPSHOT_ACCOUNTS)
      : [];
  const accounts = rawAccounts.flatMap((account: unknown) => {
    const decoded = Schema.decodeUnknownOption(AccountDiagnostics)(account);
    return decoded._tag === "Some" ? [decoded.value] : [];
  });
  const providers = { gmail: 0, outlook: 0, imap: 0 };
  for (const account of accounts) providers[account.provider]++;
  const packaged = field("packaged");
  return {
    at,
    event: "snapshot" as const,
    appVersion: versionText(field("appVersion")),
    build: versionText(field("build")),
    ...(typeof packaged === "boolean" ? { packaged } : {}),
    platform: enumField(Platform, "platform"),
    osVersion: versionText(field("osVersion")),
    arch: enumField(Arch, "arch"),
    electronVersion: versionText(field("electronVersion")),
    nodeVersion: versionText(field("nodeVersion")),
    schemaVersion:
      typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? version
        : undefined,
    supportedSchemaVersion: MIGRATIONS.length,
    ...(typeof statsPresent === "boolean" ? { plannerStatsPresent: statsPresent } : {}),
    providers,
    accounts,
  };
}

const HASH = /^[a-f0-9]{16}$/;
const INSTALL_KEY = /^[a-f0-9]{64}$/;

/**
 * The per-install HMAC key for diagnostic hashes, created on first use with mode 0600. Without
 * it, an account hash in a shared log cannot be checked against a guessed address. When the file
 * cannot be read or written, a key for this run only keeps hashes unlinkable.
 */
function installKey(file: string) {
  const read = () => {
    let text = "";
    try {
      text = readFileSync(file, "utf8").trim();
    } catch {
      /* A missing key is created below. */
    }
    return INSTALL_KEY.test(text) ? text : undefined;
  };
  const existing = read();
  if (existing !== undefined) return existing;
  const key = randomBytes(32).toString("hex");
  try {
    writeFileSync(`${file}.tmp`, key, { mode: 0o600 });
    chmodSync(`${file}.tmp`, 0o600);
    renameSync(`${file}.tmp`, file);
  } catch {
    /* A read-only data folder still gets unlinkable hashes for this run. */
  }
  return read() ?? key;
}

/** The number a hash already has in `map`, or the next free one from `first`. */
function numbered(map: Map<string, number>, value: unknown, first: number) {
  if (typeof value !== "string" || !HASH.test(value)) return Number.NaN;
  const next = map.get(value) ?? Math.max(first - 1, ...map.values()) + 1;
  map.set(value, next);
  return next;
}

export function createLocalDiagnostics(
  directory: string,
  options: {
    maxBytes?: number;
    archives?: number;
    now?: () => number;
    /** Where the per-install hash key lives. Defaults to `diagnostics.key` in `directory`. */
    keyFile?: string;
  } = {},
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
  const keyFile = options.keyFile ?? join(directory, "diagnostics.key");
  let key: string | undefined;
  const hashKey = () => (key ??= installKey(keyFile));
  /**
   * The keyed hash of each listed account, and the unkeyed hash older versions stored, mapped to
   * its snapshot index.
   */
  const accountIndexes = (accountIds: readonly string[]) => {
    const indexes = new Map<string, number>();
    for (const [index, id] of accountIds.entries()) {
      indexes.set(createHash("sha256").update(id.toLowerCase()).digest("hex").slice(0, 16), index);
      indexes.set(keyedDiagnosticHash(hashKey(), "account", id), index);
    }
    return indexes;
  };
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
  /** Writes one record and returns its line without the newline, or undefined on failure. */
  const record = (event: DiagnosticEvent, data: unknown = {}) => {
    let written: string | undefined;
    try {
      // Hashes arrive keyed: core computes them with the key `hashKey` hands to
      // DiagnosticHashKey, so this file never sees an unkeyed one.
      const text = JSON.stringify(diagnosticRecord(event, data, now()));
      const line = `${text}\n`;
      if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        for (let i = archives; i > 1; i--)
          if (existsSync(`${file}.${i - 1}`)) renameSync(`${file}.${i - 1}`, `${file}.${i}`);
        renameSync(file, `${file}.1`);
      }
      appendFileSync(file, line, { mode: 0o600 });
      chmodSync(file, 0o600);
      written = text;
    } catch {
      /* Logging failure must not crash the app. */
    }
    return written;
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
    /** The per-install key for DiagnosticHashKey. Never log or export it. */
    hashKey,
    /** `appVersion` goes on the startup record, so the log shows which build each run was. */
    begin: (appVersion?: string) => {
      const abnormalExit = health.running;
      if (abnormalExit) crash("abnormal-exit");
      health = { ...health, running: true, startedAt: now() };
      persist();
      record("startup", appVersion === undefined ? {} : { appVersion });
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
    /**
     * The export for the feedback dialog. Accounts appear as `account`, the index the snapshot
     * line uses for `accountIds`; accounts no longer listed get the next numbers. Folders get a
     * number for this export. No hash leaves the file, so a shared export cannot be matched
     * against a guessed address or against another export.
     */
    preview: (crashOnly = false, accountIds: readonly string[] = []) => {
      const accounts = accountIndexes(accountIds);
      const folders = new Map<string, number>();
      const exported = (entry: Record<string, unknown>) => {
        const { accountHash, folderHash, ...rest } = entry;
        const account = numbered(accounts, accountHash, accountIds.length);
        const folder = numbered(folders, folderHash, 0);
        return JSON.stringify({
          ...rest,
          ...(Number.isNaN(account) ? {} : { account }),
          ...(Number.isNaN(folder) ? {} : { folder }),
        });
      };
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
                entries.push(exported(diagnosticRecord(value.event, value, at)));
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
