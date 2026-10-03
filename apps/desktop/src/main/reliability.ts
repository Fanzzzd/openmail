import { requestRecoveryRelaunch } from "./recovery-actions";
import { nativeRecoveryLabels } from "./native-i18n";
import {
  ProviderDiagnostic,
  SyncResetDiagnostic,
  checkLocalDatabase,
  createLocalDiagnostics,
  runtimeDiagnosticReason,
  resetLocalCache,
  DatabaseInUseError,
  InterruptedRecoveryError,
  prepareDatabaseStartup,
} from "@openmail/core";
import { app, dialog } from "electron";
import { Logger, Schema } from "effect";
import { join } from "node:path";
import { configureWindowRecovery } from "./windows";

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
    const reset = Schema.decodeUnknownOption(SyncResetDiagnostic)(message);
    if (reset._tag === "Some") {
      localLog("sync-reset", reset.value);
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

async function chooseRecovery(integrity: ReturnType<typeof checkLocalDatabase>) {
  const labels = await nativeRecoveryLabels();
  const result = await dialog.showMessageBox({
    type: "warning",
    message: integrity === "ok" ? labels.safeMode : labels.integrityFailed,
    detail: integrity === "ok" ? labels.crashDetail : labels.integrityDetail,
    buttons: [labels.continue, labels.reset, labels.quit],
    defaultId: 2,
    cancelId: 2,
  });
  if (result.response === 2) {
    diagnostics?.finish();
    app.exit(0);
    return false;
  }
  if (result.response === 1) {
    try {
      const reset = resetLocalCache(recoveryDirectory);
      if (reset.kind === "recovered")
        await dialog.showMessageBox({
          type: "info",
          message: labels.recovered,
          detail: labels.recoveredDetail(reset.backup, reset.copied, reset.skipped),
          buttons: [labels.continue],
        });
      localLog("cache-reset");
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        message: labels.resetFailed,
        detail:
          error instanceof DatabaseInUseError
            ? labels.inUse
            : error instanceof InterruptedRecoveryError
              ? labels.interrupted(error.backups.join("\n"))
              : labels.resetFailedDetail,
        buttons: [labels.quit],
      });
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
    const labels = await nativeRecoveryLabels();
    await dialog.showMessageBox({
      type: "error",
      message: labels.resetFailed,
      detail:
        error instanceof InterruptedRecoveryError
          ? labels.interrupted(error.backups.join("\n"))
          : error instanceof DatabaseInUseError
            ? labels.inUse
            : labels.resetFailedDetail,
      buttons: [labels.quit],
    });
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
