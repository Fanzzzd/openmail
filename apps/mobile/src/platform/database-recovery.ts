import { open } from "@op-engineering/op-sqlite";
import {
  AppPaths,
  type MobileDatabaseState,
  MobileDatabaseRecovery,
  mobileDatabaseRecoveryLayer,
} from "@openmail/core/portable";
import { Effect, Layer, ManagedRuntime } from "effect";
import { filesLayer, prepareMailDirectory } from "./files";
import { cryptoLayer } from "./crypto";

const createRecoveryRuntime = () =>
  ManagedRuntime.make(
    mobileDatabaseRecoveryLayer(open).pipe(
      Layer.provide(
        Layer.mergeAll(
          filesLayer,
          cryptoLayer,
          Layer.succeed(AppPaths, { dataDirectory: Effect.sync(prepareMailDirectory) }),
        ),
      ),
    ),
  );
// Foreground and headless Mailboxes share the same connection/recovery gate.
let runtime: ReturnType<typeof createRecoveryRuntime> | undefined;
export function databaseRecoveryRuntime() {
  runtime ??= createRecoveryRuntime();
  return runtime;
}
export const openMobileDatabase = (inspection?: MobileDatabaseState) =>
  databaseRecoveryRuntime().runPromise(
    Effect.flatMap(MobileDatabaseRecovery, (recovery) => recovery.open(inspection)),
  );
