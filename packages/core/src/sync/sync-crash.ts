import { Cause, Effect, Schema } from "effect";

export const SyncCrashDiagnostic = Schema.Struct({
  _tag: Schema.Literal("SyncCrashDiagnostic"),
  reason: Schema.Literal("sync-crashed"),
  phase: Schema.Literals(["pull", "verification", "health", "headers", "maintenance"]),
  causeKind: Schema.Literals(["defect", "failure"]),
});

export function logSyncCrash<E>(
  cause: Cause.Cause<E>,
  phase: typeof SyncCrashDiagnostic.Type.phase,
) {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  return Effect.logError({
    _tag: "SyncCrashDiagnostic",
    reason: "sync-crashed",
    phase,
    causeKind: Cause.hasDies(cause) ? "defect" : "failure",
  } satisfies typeof SyncCrashDiagnostic.Type);
}
