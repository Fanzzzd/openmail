import { DiagnosticHashKey, Mailbox } from "@openmail/core";
import { ProviderError } from "@openmail/core/schema";
import { fakeServer, incoming, TestMailbox } from "@openmail/core/testing/node";
import { Effect, Layer, Logger } from "effect";
import { constVoid } from "effect/Function";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAccessDeps } from "./remote-access";
import { RemoteAccessLive } from "./remote-access-live";
import { createConnectionHub } from "./remote-rpc-server";

const captured = vi.hoisted(() => ({ deps: undefined as RemoteAccessDeps | undefined }));
vi.mock("../app/native-i18n", () => ({ nativeForbiddenText: () => "" }));
vi.mock("../app/reliability", () => ({ localLog: constVoid }));
// The controller only hands startRpc the hub once Tailscale serves; the test calls it directly.
vi.mock("./remote-access", () => ({
  createRemoteAccess: (deps: RemoteAccessDeps) => {
    captured.deps = deps;
    return {
      init: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
      refresh: () => Promise.resolve(),
      subscribe: () => constVoid,
    };
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

interface Line {
  readonly level: string;
  readonly message: readonly unknown[];
}

// The remote RPC server ran under a bare Effect.runFork that provided only Mailbox. Core runs a
// service method in the caller's fiber, so a remote Sync logged through Effect's console logger,
// outside the diagnostics file and without DiagnosticHashKey.
it("a remote Sync failure logs to the app logger with the keyed hash and nothing to the console", async () => {
  const consoleLines: unknown[] = [];
  for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args);
    });
  const lines: Line[] = [];
  const appLogger = Logger.make((options) => {
    lines.push({
      level: options.logLevel,
      message: Array.isArray(options.message) ? options.message : [options.message],
    });
  });
  const server = fakeServer("me@gmail.com", [incoming("m1")]);
  const frames: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.accounts.connect({ provider: "gmail" });
      yield* mailbox.sync.sync();
      yield* Layer.build(RemoteAccessLive);
      server.failNext = new ProviderError({
        message: "Gmail API 400: bad request for alex@example.com",
        status: 400,
      });
      lines.length = 0;
      const hub = createConnectionHub();
      const stop = captured.deps!.startRpc(hub);
      yield* Effect.promise(async () => {
        await vi.waitFor(() => expect(hub.listening).toBe(true), { interval: 10 });
        const connection = hub.onConnection({
          send: (frame) => frames.push(frame),
          close: constVoid,
        });
        connection.message(
          JSON.stringify({ _tag: "Request", id: "1", tag: "Sync", payload: null, headers: [] }),
        );
        await vi.waitFor(() => expect(frames.join("\n")).toContain('"requestId":"1"'), {
          interval: 10,
        });
        connection.closed();
        await stop();
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(TestMailbox({ gmail: server })),
      Effect.provide(Logger.layer([appLogger])),
      Effect.provideService(DiagnosticHashKey, () => "remote-test-key"),
    ),
  );
  const failed = lines
    .flatMap((line) => line.message.map((message) => ({ level: line.level, message })))
    .find(
      ({ message }) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "_tag") === "SyncFailedDiagnostic",
    );
  expect(failed?.level).toBe("Warn");
  expect(failed?.message).toMatchObject({ reason: "sync-failed", provider: "gmail" });
  expect(Reflect.get(Object(failed?.message), "accountHash")).toMatch(/^[0-9a-f]{16}$/);
  expect(consoleLines).toEqual([]);
  expect(JSON.stringify(lines)).not.toContain("alex@example.com");
});
