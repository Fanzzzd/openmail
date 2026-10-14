import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { Mailbox } from "../mailbox/mailbox.js";
import { onDeviceModelsSupported, type Host } from "../platform/host.js";
import { fakeServer, TestMailbox } from "../platform/node/testing.js";
import type { ModelRuntime } from "./media.js";

const host = (os: string, arch: string): Host => ({ timeZone: () => "UTC", os, arch });

it("on-device models run everywhere except macOS on Intel", () => {
  assert.isFalse(onDeviceModelsSupported(host("darwin", "x64")));
  assert.isTrue(onDeviceModelsSupported(host("darwin", "arm64")));
  assert.isTrue(onDeviceModelsSupported(host("linux", "x64")));
  assert.isTrue(onDeviceModelsSupported(host("win32", "x64")));
});

for (const arch of ["x64", "arm64"] as const)
  it.effect(
    `on a ${arch} Mac the models ${arch === "x64" ? "never load" : "stay available"}`,
    () => {
      const calls: string[] = [];
      const models: ModelRuntime = {
        version: "test-v1",
        status: Effect.sync(() => {
          calls.push("status");
          return { kind: "ready", total: 1, version: "test-v1" } as const;
        }),
        ensure: (download) => Effect.sync(() => void calls.push(`ensure:${download}`)),
        stop: () => Effect.void,
        embedder: { version: "test-v1", text: () => Effect.succeed([1, 0]) },
        images: {
          version: "test-v1",
          query: () => Effect.succeed([1, 0]),
          image: () => Effect.succeed([]),
        },
      };
      const server = fakeServer("me@gmail.com", []);
      return Effect.gen(function* () {
        const m = yield* Mailbox;
        const account = yield* m.accounts.connect({ provider: "gmail" });
        yield* m.ai.setAiAccount({ accountId: account.id, allowed: true, autoSummaries: false });
        yield* m.ai.setModelsEnabled(true);
        const progress = yield* m.ai.indexingProgress;
        if (arch === "arm64") {
          assert.isUndefined(progress.modelsSupported);
          assert.isTrue(progress.modelsEnabled);
          return;
        }
        // The switch stays off and says why; nothing asks the runtime for anything.
        assert.isFalse(progress.modelsSupported);
        assert.isFalse(progress.modelsEnabled);
        assert.deepStrictEqual(progress.models, { kind: "disabled" });
        const error = yield* Effect.flip(
          m.ai.semanticSearch({ search: "meaning", accountIds: [account.id] }),
        );
        assert.include(error.message, "Apple silicon");
        assert.deepStrictEqual(calls, []);
      }).pipe(
        Effect.provide(
          TestMailbox({ gmail: server }, { backgroundFlush: false, models }, {}, undefined, {
            host: host("darwin", arch),
          }),
        ),
      );
    },
  );
