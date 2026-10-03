import type { CacheResetResult } from "../../../../packages/core/src/platform/node/database-recovery.js";
import { Effect, Logger } from "effect";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createLocalDiagnostics } from "../../../../packages/core/src/platform/node/diagnostics.js";
const native = vi.hoisted(() => ({
  response: 0,
  integrity: "ok",
  exit: vi.fn(),
  relaunch: vi.fn(),
  startup: vi.fn(),
  reset: vi.fn<() => CacheResetResult>(() => ({ kind: "reset" })),
  check: vi.fn(),
  configured: vi.fn(),
  guardedRelaunch: vi.fn(async () => false),
  recover: (_code: number): boolean => false,
  dialogs: vi.fn(),
}));
vi.mock("@openmail/core", async () => ({
  ...(await import("../../../../packages/core/src/platform/node/diagnostics.js")),
  ...(await import("../../../../packages/core/src/platform/node/database-access.js")),
  ...(await import("../../../../packages/core/src/platform/node/recovery-files.js")),
  prepareDatabaseStartup: native.startup,
  checkLocalDatabase: () => {
    native.check();
    return native.integrity;
  },
  resetLocalCache: native.reset,
}));
vi.mock("./windows", () => ({
  configureWindowRecovery: (
    _file: string,
    recover: (code: number) => boolean,
    options: unknown,
  ) => {
    native.configured(options);
    native.recover = recover;
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
it("a clean startup does not perform a synchronous integrity scan", async () => {
  const recovery = await import("./reliability");
  expect(await recovery.prepareReliability(temp())).toBe(true);
  expect(native.check).not.toHaveBeenCalled();
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
