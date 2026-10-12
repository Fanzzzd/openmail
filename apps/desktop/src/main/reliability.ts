import { requestRecoveryRelaunch } from "./recovery-actions";
import { nativeRecoveryLabels } from "./native-i18n";
import {
  ProviderDiagnostic,
  ReauthDiagnostic,
  SyncResetDiagnostic,
  SyncCrashDiagnostic,
  checkLocalDatabase,
  createLocalDiagnostics,
  runtimeDiagnosticReason,
  resetLocalCache,
  DatabaseInUseError,
  InterruptedRecoveryError,
  prepareDatabaseStartup,
} from "@openmail/core";
import { app } from "electron";
import { Logger, Schema } from "effect";
import { join } from "node:path";
import { configureWindowRecovery } from "./windows";
import type { RecoveryPrompt } from "../shared/recovery";
import { nativeAsk } from "./native-fallback";
import { openRecoveryWindow, recoveryPrompt, type RecoveryDeps } from "./recovery-window";

let diagnostics: ReturnType<typeof createLocalDiagnostics> | undefined;
let crashed = false;
let recoveryPending = false;
export const localLog = (
  event: Parameters<ReturnType<typeof createLocalDiagnostics>["record"]>[0],
  data?: unknown,
) => diagnostics?.record(event, data);
export const diagnosticsLogger = Logger.make((options) => {
  const messages: readonly unknown[] = Array.isArray(options.message)
    ? options.message
    : [options.message];
  let classified = false;
  for (const message of messages) {
    const crash = Schema.decodeUnknownOption(SyncCrashDiagnostic)(message);
    if (crash._tag === "Some") {
      localLog("runtime-error", crash.value);
      classified = true;
    }
    const reset = Schema.decodeUnknownOption(SyncResetDiagnostic)(message);
    if (reset._tag === "Some") {
      localLog("sync-reset", reset.value);
      classified = true;
    }
    const reauth = Schema.decodeUnknownOption(ReauthDiagnostic)(message);
    if (reauth._tag === "Some") {
      localLog("reauth", reauth.value);
      classified = true;
    }
    const provider = Schema.decodeUnknownOption(ProviderDiagnostic)(message);
    if (provider._tag === "Some") {
      localLog("provider-failure", provider.value);
      classified = true;
      process.stderr.write(`[provider-failure] ${JSON.stringify(provider.value)}\n`);
    }
  }
  if (classified) return;
  const reason = runtimeDiagnosticReason(messages);
  if (options.logLevel === "Error" || options.logLevel === "Fatal")
    localLog("runtime-error", { reason });
  else if (options.logLevel === "Warn") localLog("runtime-warning", { reason });
});
export const diagnosticsPreview = (crashOnly: boolean) => diagnostics?.preview(crashOnly) ?? "";
export const hasCrashReport = () => crashed;
export const dismissCrashReport = () => {
  crashed = false;
  diagnostics?.acknowledge();
};

/** The native box is the fallback when the React recovery window cannot paint. */
const nativeRecoveryPrompt = (prompt: RecoveryPrompt) =>
  nativeAsk({
    type: prompt.tone,
    message: prompt.message,
    detail: prompt.detail,
    buttons: prompt.buttons,
    defaultId: prompt.defaultId,
    cancelId: prompt.cancelId,
  });
let openSurface: RecoveryDeps["open"] = openRecoveryWindow;
/** Tests replace the window; production always opens renderer/recovery.html. */
export const setRecoverySurface = (open: RecoveryDeps["open"]) => {
  openSurface = open;
};
const ask = (prompt: Omit<RecoveryPrompt, "defaultId" | "cancelId"> & Partial<RecoveryPrompt>) =>
  recoveryPrompt(
    { defaultId: 0, cancelId: 0, ...prompt },
    { open: openSurface, fallback: nativeRecoveryPrompt },
  );
type Labels = Awaited<ReturnType<typeof nativeRecoveryLabels>>;
const resetFailure = (labels: Labels, error: unknown) =>
  ask({
    locale: labels.locale,
    tone: "error",
    message: labels.resetFailed,
    detail:
      error instanceof InterruptedRecoveryError
        ? labels.interrupted(error.backups.join("\n"))
        : error instanceof DatabaseInUseError
          ? labels.inUse
          : labels.resetFailedDetail,
    buttons: [labels.quit],
  });

async function chooseRecovery(integrity: ReturnType<typeof checkLocalDatabase>) {
  const labels = await nativeRecoveryLabels();
  const response = await ask({
    locale: labels.locale,
    tone: "warning",
    message: integrity === "ok" ? labels.safeMode : labels.integrityFailed,
    detail: integrity === "ok" ? labels.crashDetail : labels.integrityDetail,
    buttons: [labels.continue, labels.reset, labels.quit],
    defaultId: 2,
    cancelId: 2,
    destructiveId: 1,
  });
  if (response === 2) {
    diagnostics?.finish();
    app.exit(0);
    return false;
  }
  if (response === 1) {
    try {
      const reset = resetLocalCache(recoveryDirectory);
      if (reset.kind === "recovered")
        await ask({
          locale: labels.locale,
          tone: "info",
          message: labels.recovered,
          detail: labels.recoveredDetail(reset.backup, reset.copied, reset.skipped),
          buttons: [labels.continue],
        });
      localLog("cache-reset");
    } catch (error) {
      await resetFailure(labels, error);
      diagnostics?.finish();
      app.exit(1);
      return false;
    }
  }
  diagnostics?.resetCrashHistory();
  // Keep the separate redacted report until the person has decided whether to attach it.
  return true;
}
let recoveryDirectory = "";
export async function prepareReliability(directory: string) {
  recoveryDirectory = directory;
  diagnostics = createLocalDiagnostics(join(directory, "diagnostics"));
  const health = diagnostics.begin();
  crashed = health.crashed;
  try {
    prepareDatabaseStartup(directory);
  } catch (error) {
    await resetFailure(await nativeRecoveryLabels(), error);
    diagnostics.finish();
    app.exit(1);
    return false;
  }
  const needsCheck = health.abnormalExit || health.safeMode;
  const integrity = needsCheck ? checkLocalDatabase(directory) : "ok";
  if (needsCheck) localLog(integrity === "ok" ? "integrity-ok" : "integrity-failed");
  const safeMode = health.safeMode || integrity !== "ok";
  if (safeMode && !(await chooseRecovery(integrity))) return false;
  let lastCrash = -Infinity;
  configureWindowRecovery(
    join(directory, "windows.json"),
    (code) => {
      const now = Date.now();
      if (now - lastCrash < 3000) return recoveryPending;
      lastCrash = now;
      crashed = true;
      if (!diagnostics?.crash("renderer-crash", code) || recoveryPending) return recoveryPending;
      recoveryPending = true;
      // The shared quit guard collects live and lost renderer send states before relaunch.
      void requestRecoveryRelaunch().then((approved) => {
        if (!approved) recoveryPending = false;
        return approved;
      });
      return true;
    },
    { safeMode },
  );
  app.on("quit", (_event, code) => {
    if (code === 0) diagnostics?.finish();
  });
  return true;
}
