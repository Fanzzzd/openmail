import { fileURLToPath } from "node:url";
import { Mailbox } from "@openmail/core";
import { DeviceError, InvalidInput } from "@openmail/core/schema";
import { Context, Effect, Fiber, Layer, Queue, Stream } from "effect";
import type { RemoteAccessView } from "../../shared/remote-access";
import { nativeForbiddenText } from "../app/native-i18n";
import { localLog } from "../app/reliability";
import { createRemoteAccess, type RemoteAccessController } from "./remote-access";
import { remoteRpcServer } from "./remote-rpc-server";
import { sessionTailscale } from "./tailscale";

export class RemoteAccess extends Context.Service<
  RemoteAccess,
  {
    readonly view: Stream.Stream<RemoteAccessView>;
    readonly refresh: Effect.Effect<void>;
    setEnabled(enabled: boolean): Effect.Effect<void, InvalidInput | DeviceError>;
    setAllowlist(logins: readonly string[]): Effect.Effect<void, InvalidInput | DeviceError>;
    setService(service: string): Effect.Effect<void, InvalidInput | DeviceError>;
    disconnect(id: string): Effect.Effect<void>;
  }
>()("openmail/RemoteAccess") {}

const attempt = (task: () => Promise<void>) =>
  Effect.tryPromise({
    try: task,
    catch: (error) =>
      error instanceof InvalidInput
        ? error
        : new DeviceError({ message: "Remote access could not be changed." }),
  });

const remoteAccessService = (controller: RemoteAccessController) =>
  RemoteAccess.of({
    view: Stream.callback<RemoteAccessView>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          controller.subscribe((view) => {
            Queue.offerUnsafe(queue, view);
          }),
        ),
        (off) => Effect.sync(off),
      ),
    ),
    refresh: Effect.promise(() => controller.refresh().catch(() => null)).pipe(Effect.asVoid),
    setEnabled: (enabled) => attempt(() => controller.setEnabled(enabled)),
    setAllowlist: (logins) => attempt(() => controller.setAllowlist(logins)),
    setService: (service) => attempt(() => controller.setService(service)),
    disconnect: (id) => Effect.sync(() => controller.disconnect(id)),
  });

/** Remote access for the desktop app. Off unless the person turned it on in Settings. */
export const RemoteAccessLive = Layer.effect(
  RemoteAccess,
  Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const tailscale = sessionTailscale(process.env);
    const controller = createRemoteAccess({
      mailbox,
      runCli: tailscale.runCli,
      installed: tailscale.installed,
      // out/main/index.js → out/web, the renderer's web build.
      webRoot: fileURLToPath(new URL("../web/", import.meta.url)),
      startRpc: (hub) => {
        const fiber = Effect.runFork(
          Layer.launch(
            remoteRpcServer(hub, {
              denied: (tag) => localLog("rpc-auth-failure", { rpc: tag }),
              failure: (tag) => localLog("rpc-failure", { rpc: tag }),
            }),
          ).pipe(Effect.provideService(Mailbox, mailbox)),
        );
        return () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid));
      },
      log: (reason) => process.stderr.write(`[remote-access] refused: ${reason}\n`),
      forbiddenText: nativeForbiddenText,
    });
    yield* Effect.promise(() => controller.init().catch(() => null)).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.promise(() => controller.dispose().catch(() => null)));
    return remoteAccessService(controller);
  }),
);
