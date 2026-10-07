import { spawn } from "node:child_process";
import { once } from "node:events";
import { Mailbox } from "@openmail/core";
import { ConfigProvider, Effect, Layer, Sink, Stdio, Stream } from "effect";
import { TestConsole } from "effect/testing";
import { expect, it } from "vitest";
import { Store, fakeServer, TestMailbox } from "@openmail/core/testing/node";
import { withProgress } from "./sync-progress.js";

it("prints sync start before the operation and subscribes to progress", async () => {
  const writes: string[] = [];
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.empty,
    stdout: () => Sink.drain,
    stderr: () =>
      Sink.forEachArray((chunks) =>
        Effect.sync(() => {
          for (const chunk of chunks) writes.push(String(chunk));
        }),
      ),
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      yield* mailbox.connect({ provider: "gmail" });
      yield* withProgress(
        Effect.gen(function* () {
          expect(yield* TestConsole.errorLines).toContain("Syncing mail…");
          return yield* mailbox.sync();
        }),
        true,
      );
      expect(writes.join("")).toContain("gmail:me@gmail.com");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestMailbox({ gmail: fakeServer("me@gmail.com") }),
          TestConsole.layer,
          Layer.succeed(Stdio.Stdio, stdio),
        ),
      ),
    ),
  );
});

it("JSON sync leaves stdout and stderr free of progress", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* withProgress(Effect.succeed("result"), false)).toBe("result");
      expect(yield* TestConsole.errorLines).toEqual([]);
    }).pipe(Effect.provide(TestConsole.layer)),
  );
});

it("read-only sync returns with pending operations intact", async () => {
  const server = fakeServer("fake@example.com");
  const layer = TestMailbox({ gmail: server }, { backgroundFlush: false }).pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ OPENMAIL_READ_ONLY: "1" }))),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const mailbox = yield* Mailbox;
      const store = yield* Store;
      const account = yield* mailbox.connect({ provider: "gmail" });
      yield* store.enqueueOp(account.id, "fake-message", { kind: "star", value: true });
      const before = yield* store.listPendingOps;
      yield* withProgress(mailbox.sync(account.id), false);
      expect(yield* store.listPendingOps).toEqual(before);
      expect(server.pushed).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  it(`the CLI Effect runtime interrupts sync and exits on ${signal}`, async () => {
    // Same runtime and progress function as cli.ts, backed only by in-memory fake services.
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { NodeRuntime, NodeServices } from '@effect/platform-node';
      import { Effect, Layer } from 'effect';
      import { TestMailbox, fakeServer } from '../core/dist/platform/node/testing.js';
      import { withProgress } from './dist/sync-progress.js';
      NodeRuntime.runMain(withProgress(Effect.sync(() => process.stderr.write('sync-waiting\\n')).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.sync(() => process.stderr.write('interrupted\\n')))), true).pipe(Effect.provide(Layer.mergeAll(TestMailbox({gmail: fakeServer('fake@example.com')}), NodeServices.layer))));
    `,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stderr.on("data", (chunk) => {
          output += String(chunk);
          if (output.includes("sync-waiting")) resolve();
        });
        child.once("exit", (code) =>
          reject(new Error(`Fixture exited before ready (${code}): ${output}`)),
        );
      });
      const exited = once(child, "exit");
      child.kill(signal);
      const [code, exitSignal] = await exited;
      expect(exitSignal).toBeNull();
      expect(code).not.toBe(0);
      expect(output).toContain("interrupted");
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 10000);
}
