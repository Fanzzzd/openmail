import { type CacheResetResult } from "../../../../../packages/core/src/platform/node/database-recovery.js";
import { Effect, Logger } from "effect";
import { HttpClientRequest } from "effect/http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalDiagnostics } from "../../../../../packages/core/src/platform/node/diagnostics.js";
import {
  DiagnosticHashKey,
  keyedDiagnosticHash,
  logWarning,
} from "../../../../../packages/core/src/domain/diagnostic-log.js";
import { logProviderFailure } from "../../../../../packages/core/src/providers/provider-diagnostics.js";
const native = vi.hoisted(() => ({
  response: 0,
  integrity: "ok",
  exit: vi.fn(),
  relaunch: vi.fn(),
  startup: vi.fn(),
  reset: vi.fn<() => CacheResetResult>(() => ({ kind: "reset" })),
  check: vi.fn(),
  progress: vi.fn<(kind: string) => void>(),
  dismissProgress: vi.fn(),
  configured: vi.fn(),
  guardedRelaunch: vi.fn(async () => false),
  recover: (_code: number): boolean => false,
  dialogs: vi.fn(),
  newer: vi.fn((_directory: string): number | undefined => undefined),
}));
vi.mock("@openmail/core", async () => ({
  ...(await import("../../../../../packages/core/src/platform/node/diagnostics.js")),
  ...(await import("../../../../../packages/core/src/platform/node/database-access.js")),
  ...(await import("../../../../../packages/core/src/platform/node/recovery-files.js")),
  prepareDatabaseStartup: native.startup,
  checkLocalDatabaseInWorker: async () => {
    native.check();
    return native.integrity;
  },
  resetLocalCache: native.reset,
  newerDatabaseVersion: (directory: string) => native.newer(directory),
}));
vi.mock("../windows/windows", () => ({
  configureWindowRecovery: (
    _file: string,
    recover: (code: number) => boolean,
    options: unknown,
  ) => {
    native.configured(options);
    native.recover = recover;
  },
}));
vi.mock("./database-upgrade", () => ({
  showDatabaseProgress: async (kind: string) => {
    native.progress(kind);
    return native.dismissProgress;
  },
}));
vi.mock("./recovery-actions", () => ({ requestRecoveryRelaunch: native.guardedRelaunch }));
vi.mock("electron", () => ({
  app: Object.assign(new EventEmitter(), { exit: native.exit, relaunch: native.relaunch }),
  dialog: {
    showMessageBox: async (options: unknown) => {
      native.dialogs(options);
      return { response: native.response };
    },
  },
}));
vi.mock("./native-i18n", () => ({
  nativeRecoveryLabels: () => ({
    safeMode: "Safe mode",
    integrityFailed: "Integrity failed",
    crashDetail: "Three crashes",
    integrityDetail: "quick_check failed",
    continue: "Continue",
    reset: "Reset cache",
    quit: "Quit",
    recovered: "Recovered",
    recoveredDetail: (backup: string) => backup,
    inUse: "Close other OpenMail processes (CLI/MCP)",
    interrupted: (backup: string) => `Interrupted recovery: ${backup}`,
    resetFailed: "Reset failed",
    resetFailedDetail: "Database kept",
  }),
}));
const dirs: string[] = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "openmail-recovery-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native.response = 0;
  native.integrity = "ok";
  (await import("electron")).app.removeAllListeners();
  vi.resetModules();
});

it("shows the recovery choices before cache reset and leaves a previewable crash report", async () => {
  const dir = temp();
  const prior = createLocalDiagnostics(join(dir, "diagnostics"));
  prior.begin();
  for (let i = 0; i < 3; i++) prior.crash("renderer-crash", 137);
  prior.finish();
  native.response = 1;
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(true);
  expect(native.dialogs).toHaveBeenCalledWith(
    expect.objectContaining({ buttons: ["Continue", "Reset cache", "Quit"] }),
  );
  expect(native.reset).toHaveBeenCalledWith(dir);
  expect(recovery.hasCrashReport()).toBe(true);
  expect(recovery.diagnosticsPreview(true)).toContain("renderer-crash");
  recovery.dismissCrashReport();
  expect(recovery.hasCrashReport()).toBe(false);
  expect(native.relaunch).not.toHaveBeenCalled();
});
it("a database from a newer OpenMail never reaches safe mode or its cache reset", async () => {
  const dir = temp();
  const prior = createLocalDiagnostics(join(dir, "diagnostics"));
  prior.begin();
  for (let i = 0; i < 3; i++) prior.crash("renderer-crash", 137);
  native.newer.mockReturnValueOnce(1000);
  native.response = 1;
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(true);
  expect(native.dialogs).not.toHaveBeenCalled();
  expect(native.check).not.toHaveBeenCalled();
  expect(native.reset).not.toHaveBeenCalled();
  // Startup then refuses the database and exits cleanly.
  recovery.finishCleanly();
  expect(createLocalDiagnostics(join(dir, "diagnostics")).begin().abnormalExit).toBe(false);
});

it("offers quit on failed integrity and never resets without a user choice", async () => {
  native.integrity = "unavailable";
  native.response = 2;
  const dir = temp();
  createLocalDiagnostics(join(dir, "diagnostics")).begin();
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(false);
  expect(native.dialogs).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Integrity failed", detail: "quick_check failed" }),
  );
  expect(native.reset).not.toHaveBeenCalled();
  expect(native.exit).toHaveBeenCalledWith(0);
});
it("debounces shared-process crashes and requests a guarded relaunch without forced exit", async () => {
  let at = 100;
  vi.spyOn(Date, "now").mockImplementation(() => at);
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(temp())).toBe(true);
  expect(native.recover(137)).toBe(false);
  expect(native.recover(137)).toBe(false);
  expect(native.recover(137)).toBe(false);
  expect(recovery.diagnosticsPreview(true).split("\n")).toHaveLength(1);
  at += 3001;
  expect(native.recover(139)).toBe(false);
  at += 3001;
  expect(native.recover(137)).toBe(true);
  await Promise.resolve();
  expect(native.guardedRelaunch).toHaveBeenCalledOnce();
  expect(native.exit).not.toHaveBeenCalled();
  expect(native.relaunch).not.toHaveBeenCalled();
  expect(native.reset).not.toHaveBeenCalled();
  expect(recovery.hasCrashReport()).toBe(true);
});
it("a clean startup does not perform an integrity scan", async () => {
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(temp())).toBe(true);
  expect(native.check).not.toHaveBeenCalled();
  expect(native.progress).not.toHaveBeenCalled();
  expect(native.configured).toHaveBeenCalledWith({ safeMode: false });
});
it("Continue clears the loop counter and discards saved windows while retaining the report", async () => {
  const dir = temp();
  const old = createLocalDiagnostics(join(dir, "diagnostics"));
  old.begin();
  for (let i = 0; i < 3; i++) old.crash("renderer-crash");
  old.finish();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  expect(native.configured).toHaveBeenCalledWith({ safeMode: true });
  (await import("electron")).app.emit("quit", {}, 0);
  const next = createLocalDiagnostics(join(dir, "diagnostics"));
  expect(next.begin().safeMode).toBe(false);
  expect(next.preview(true)).toContain("renderer-crash");
});

it("the installed runtime logger drops raw errors, mail content and credentials", async () => {
  const recovery = await import("./reliability");
  await recovery.prepareReliability(temp());
  const privateText =
    "alice@example.com Quarterly secret subject confidential body Bearer ya29.PrivateToken";
  Effect.runSync(
    Effect.logError(privateText, new Error(privateText)).pipe(
      Effect.provide(Logger.layer([recovery.diagnosticsLogger])),
    ),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain("runtime-error");
  for (const piece of privateText.split(" ")) expect(preview).not.toContain(piece);
});

it("shows the preserved original database location after corruption recovery", async () => {
  const dir = temp();
  createLocalDiagnostics(join(dir, "diagnostics")).begin();
  native.integrity = "corrupt";
  native.response = 1;
  native.reset.mockReturnValueOnce({
    kind: "recovered",
    backup: join(dir, "mail.db.corrupt-test"),
    copied: 10,
    skipped: 1,
  });
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(true);
  expect(native.dialogs).toHaveBeenLastCalledWith(
    expect.objectContaining({ message: "Recovered", detail: join(dir, "mail.db.corrupt-test") }),
  );
  (await import("electron")).app.emit("quit", {}, 0);
  expect(createLocalDiagnostics(join(dir, "diagnostics")).begin().safeMode).toBe(false);
});

it("refuses reset with a clear instruction to close CLI/MCP when the lock is held", async () => {
  const { DatabaseInUseError } = await import("@openmail/core");
  const dir = temp();
  createLocalDiagnostics(join(dir, "diagnostics")).begin();
  native.integrity = "corrupt";
  native.response = 1;
  native.reset.mockImplementationOnce(() => {
    throw new DatabaseInUseError();
  });
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(false);
  expect(native.dialogs).toHaveBeenLastCalledWith(
    expect.objectContaining({ detail: "Close other OpenMail processes (CLI/MCP)" }),
  );
});
it("reports a preserved backup and exits before core can create an empty database", async () => {
  const { InterruptedRecoveryError } = await import("@openmail/core");
  const dir = temp();
  const backup = join(dir, "mail.db.corrupt-test");
  native.startup.mockImplementationOnce(() => {
    throw new InterruptedRecoveryError([backup]);
  });
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(false);
  expect(native.dialogs).toHaveBeenLastCalledWith(
    expect.objectContaining({ detail: `Interrupted recovery: ${backup}` }),
  );
  expect(native.configured).not.toHaveBeenCalled();
});

it("records only redacted provider failure fields from the core logger", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.logWarning({
      _tag: "ProviderDiagnostic",
      provider: "outlook",
      method: "GET",
      endpoint: "/me/mailboxSettings",
      status: 403,
      accountHash: "0123456789abcdef",
      body: "private message",
      token: "secret token",
      account: "private@example.com",
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"provider-failure"');
  expect(preview).toContain('"endpoint":"/me/mailboxSettings"');
  expect(preview).toContain('"status":403');
  expect(preview).not.toMatch(/private|secret|token/);
});

it("smoke diagnostics retain sync reset counts and redact folder and mail data", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.logWarning({
      _tag: "SyncResetDiagnostic",
      provider: "outlook",
      accountHash: "0123456789abcdef",
      folderHash: "abcdef0123456789",
      phase: "reset",
      listed: 10,
      kept: 10,
      local: 100,
      candidates: 90,
      verified: 0,
      incomplete: 0,
      deferred: 90,
      body: "private message",
      folder: "private folder",
      account: "private@example.com",
      token: "secret token",
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"event":"sync-reset"');
  expect(preview).toContain('"local":100');
  expect(preview).toContain('"candidates":90');
  expect(preview).not.toMatch(/private|secret|token/);
});

it("sync reset progress does not produce a burst of duplicate runtime warnings, and runtime failures have safe reasons", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.gen(function* () {
      for (let index = 0; index < 21; index++)
        yield* Effect.logWarning({
          _tag: "SyncResetDiagnostic",
          provider: "outlook",
          accountHash: "0123456789abcdef",
          folderHash: "abcdef0123456789",
          phase: "reset",
          listed: 20,
          kept: 20,
          local: 20,
          candidates: 0,
          verified: 0,
          incomplete: 0,
          deferred: 0,
        });
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  expect(recovery.diagnosticsPreview(false).match(/"event":"sync-reset"/g)).toHaveLength(21);
  expect(recovery.diagnosticsPreview(false)).not.toContain('"event":"runtime-warning"');
  await Effect.runPromise(
    logWarning(
      "history-backfill-failed",
      "backfill failed",
      new Error("private@example.test secret body"),
    ).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"reason":"history-backfill-failed"');
  expect(preview).not.toMatch(/private|secret|body/);
});

it("runtime reason codes come from the code at the log site, never from message text or inherited object keys", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    logWarning("header-backfill-failed", "private@example.test secret body").pipe(
      Effect.provide(Logger.layer([recovery.diagnosticsLogger])),
    ),
  );
  await Effect.runPromise(
    Effect.logWarning("uncoded").pipe(
      Effect.annotateLogs("logCode", "private@example.test"),
      Effect.provide(Logger.layer([recovery.diagnosticsLogger])),
    ),
  );
  for (const message of [
    "Header backfill failed",
    "constructor",
    "__proto__",
    "private@example.test secret body",
  ]) {
    await Effect.runPromise(
      Effect.logWarning(message, { reason: "private@example.test", token: "secret" }).pipe(
        Effect.provide(Logger.layer([recovery.diagnosticsLogger])),
      ),
    );
  }
  recovery.localLog("runtime-warning", { reason: "private@example.test secret body" });
  recovery.localLog("runtime-error", { reason: "header-backfill-failed", body: "private" });
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"reason":"header-backfill-failed"');
  expect(preview.match(/"reason":"header-backfill-failed"/g)).toHaveLength(2);
  expect(preview.match(/"reason":"unclassified"/g)).toHaveLength(6);
  expect(preview).not.toMatch(/private|secret|body|constructor|__proto__/);
});

it("core sync crashes retain safe phase and cause codes", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.logError({
      _tag: "SyncCrashDiagnostic",
      reason: "sync-crashed",
      phase: "pull",
      causeKind: "defect",
      message: "private body",
      token: "private token",
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"reason":"sync-crashed"');
  expect(preview).toContain('"phase":"pull"');
  expect(preview).toContain('"causeKind":"defect"');
  expect(preview).not.toContain("private");
});

// Core logged the unkeyed SHA-256 prefix of the account ID, and the main process copied the
// provider-failure line to stderr, where `npm run dev` and Console.app show it.
it("the main process's stderr and diagnostics file get only the keyed account hash", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  const accountId = "gmail:private@example.com";
  const written: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await Effect.runPromise(
      logProviderFailure(
        "gmail",
        accountId,
        HttpClientRequest.get("https://gmail.googleapis.com/gmail/v1/users/me/profile"),
        {
          _tag: "ProviderError",
          status: 500,
        },
      ).pipe(
        Effect.provide(Logger.layer([recovery.diagnosticsLogger])),
        Effect.provideService(DiagnosticHashKey, recovery.diagnosticHashKey),
      ),
    );
  } finally {
    write.mockRestore();
  }
  const key = readFileSync(join(dir, "diagnostics.key"), "utf8");
  const keyed = keyedDiagnosticHash(key, "account", accountId);
  const unkeyed = createHash("sha256").update(accountId).digest("hex").slice(0, 16);
  const stderr = written.join("");
  expect(stderr).toContain(`[provider-failure] `);
  expect(stderr).toContain(`"accountHash":"${keyed}"`);
  expect(stderr).not.toContain(unkeyed);
  const file = readFileSync(join(dir, "diagnostics", "diagnostics.jsonl"), "utf8");
  expect(file).toContain(`"accountHash":"${keyed}"`);
  expect(file).not.toContain(unkeyed);
});

it("IMAP sync failures are recorded as fixed sync-failed fields", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.logWarning({
      _tag: "SyncFailedDiagnostic",
      reason: "sync-failed",
      provider: "imap",
      failure: "network",
      scope: "full",
      accountHash: "0123456789abcdef",
      message: "private body",
      host: "imap.private.example",
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"reason":"sync-failed"');
  expect(preview).toContain('"provider":"imap"');
  expect(preview).toContain('"failure":"network"');
  expect(preview).not.toContain("private");
});

it("a skipped planner statistics refresh is recorded with its SQLite code only", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir);
  await Effect.runPromise(
    Effect.logWarning({
      _tag: "PlannerStatsSkippedDiagnostic",
      reason: "planner-stats-skipped",
      code: 5,
      path: "/Users/private/mail.db",
    }).pipe(Effect.provide(Logger.layer([recovery.diagnosticsLogger]))),
  );
  const preview = recovery.diagnosticsPreview(false);
  expect(preview).toContain('"event":"runtime-warning","reason":"planner-stats-skipped","code":5');
  expect(preview).not.toContain("private");
});

it("an abnormal exit checks the database in a worker behind a painted progress window", async () => {
  const dir = temp();
  createLocalDiagnostics(join(dir, "diagnostics")).begin();
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(dir)).toBe(true);
  expect(native.check).toHaveBeenCalledOnce();
  expect(native.progress).toHaveBeenCalledWith("checking");
  expect(native.dismissProgress).toHaveBeenCalledOnce();
  expect(native.dialogs).not.toHaveBeenCalled();
});

it("the feedback export puts the snapshot line first, then the stored records", async () => {
  const dir = temp();
  const recovery = await import("./reliability");
  await recovery.prepareReliability(dir, "0.4.1");
  const { diagnosticSnapshot } =
    await import("../../../../../packages/core/src/platform/node/diagnostics.js");
  const [first, ...rest] = recovery
    .diagnosticsPreview(false, diagnosticSnapshot({ appVersion: "0.4.1" }, undefined, 5))
    .split("\n");
  expect(JSON.parse(first ?? "")).toMatchObject({ event: "snapshot", appVersion: "0.4.1" });
  expect(rest.join("\n")).toContain('"event":"startup","appVersion":"0.4.1"');
  expect(recovery.diagnosticsPreview(false)).not.toContain('"snapshot"');
});
