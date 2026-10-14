import { requestRecoveryRelaunch } from "./recovery-actions";
import { nativeRecoveryLabels } from "./native-i18n";
import {
  ProviderDiagnostic,
  ReauthDiagnostic,
  SyncResetDiagnostic,
  SyncCrashDiagnostic,
  SyncFailedDiagnostic,
  PlannerStatsSkippedDiagnostic,
  checkLocalDatabaseInWorker,
  createLocalDiagnostics,
  runtimeDiagnosticReason,
  newerDatabaseVersion,
  resetLocalCache,
  DatabaseInUseError,
  InterruptedRecoveryError,
  prepareDatabaseStartup,
} from "@openmail/core";
import { app } from "electron";
import { Logger, References, Schema } from "effect";
import { join } from "node:path";
import { configureWindowRecovery } from "../windows/windows";
import { showDatabaseProgress } from "./database-upgrade";
import type { RecoveryPrompt } from "../../shared/recovery";
import { nativeAsk } from "../system/native-fallback";
import { openRecoveryWindow, recoveryPrompt } from "./recovery-window";

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
    const syncFailed = Schema.decodeUnknownOption(SyncFailedDiagnostic)(message);
    if (syncFailed._tag === "Some") {
      localLog("runtime-warning", syncFailed.value);
      classified = true;
    }
    const plannerStats = Schema.decodeUnknownOption(PlannerStatsSkippedDiagnostic)(message);
    if (plannerStats._tag === "Some") {
      // diagnosticRecord keeps the reason and the numeric SQLite code, nothing else.
      localLog("runtime-warning", plannerStats.value);
      classified = true;
    }
    const reauth = Schema.decodeUnknownOption(ReauthDiagnostic)(message);
    if (reauth._tag === "Some") {
      localLog("reauth", reauth.value);
      classified = true;
    }
    const provider = Schema.decodeUnknownOption(ProviderDiagnostic)(message);
    if (provider._tag === "Some") {
      // The stored line carries the keyed account hash; the unkeyed one never leaves memory.
      const line = localLog("provider-failure", provider.value);
      classified = true;
      if (line !== undefined) process.stderr.write(`[provider-failure] ${line}\n`);
    }
  }
  if (classified) return;
  const reason = runtimeDiagnosticReason(options.fiber.getRef(References.CurrentLogAnnotations));
  if (options.logLevel === "Error" || options.logLevel === "Fatal")
    localLog("runtime-error", { reason });
  else if (options.logLevel === "Warn") localLog("runtime-warning", { reason });
});
/** A deliberate refusal to start (a newer database) is a clean exit, not a crash. */
export const finishCleanly = () => diagnostics?.finish();
/** The export the feedback email attaches: the snapshot line first, then the stored records. */
export const diagnosticsPreview = (
  crashOnly: boolean,
  snapshot?: object,
  accountIds: readonly string[] = [],
) =>
  [
    snapshot === undefined ? "" : JSON.stringify(snapshot),
    diagnostics?.preview(crashOnly, accountIds) ?? "",
  ]
    .filter(Boolean)
    .join("\n");
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
const ask = (prompt: Omit<RecoveryPrompt, "defaultId" | "cancelId"> & Partial<RecoveryPrompt>) =>
  recoveryPrompt(
    { defaultId: 0, cancelId: 0, ...prompt },
    { open: openRecoveryWindow, fallback: nativeRecoveryPrompt },
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

async function chooseRecovery(integrity: Awaited<ReturnType<typeof checkLocalDatabaseInWorker>>) {
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
/** quick_check reads every page. A worker runs it while the progress window paints. */
async function checkWithProgress(directory: string) {
  const check = checkLocalDatabaseInWorker(directory);
  const dismiss = await showDatabaseProgress("checking");
  try {
    return await check;
  } finally {
    dismiss();
  }
}
let recoveryDirectory = "";
export async function prepareReliability(directory: string, appVersion?: string) {
  recoveryDirectory = directory;
  // The hash key sits beside the diagnostics folder, so sharing that folder does not share it.
  diagnostics = createLocalDiagnostics(join(directory, "diagnostics"), {
    keyFile: join(directory, "diagnostics.key"),
  });
  const health = diagnostics.begin(appVersion);
  crashed = health.crashed;
  try {
    prepareDatabaseStartup(directory);
  } catch (error) {
    await resetFailure(await nativeRecoveryLabels(), error);
    diagnostics.finish();
    app.exit(1);
    return false;
  }
  // A database a newer OpenMail migrated is refused at startup with its own message. Safe mode
  // must not offer Reset for it: the rebuild would write this version's schema into it.
  const tooNew = newerDatabaseVersion(directory) !== undefined;
  const needsCheck = !tooNew && (health.abnormalExit || health.safeMode);
  const integrity = needsCheck ? await checkWithProgress(directory) : "ok";
  if (needsCheck) localLog(integrity === "ok" ? "integrity-ok" : "integrity-failed");
  const safeMode = !tooNew && (health.safeMode || integrity !== "ok");
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
