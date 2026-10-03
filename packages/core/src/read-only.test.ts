import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { makeGmail } from "./gmail.js";
import { makeOutlook } from "./outlook.js";
import { makeImap } from "./platform/node/imap.js";
import { MemoryPlatform } from "./platform/node/platform-memory.js";
import { READ_ONLY_METHODS, readOnlyAdapter, READ_ONLY_MESSAGE, refused } from "./read-only.js";

it.effect(
  "every real provider method is explicitly read-allowlisted or refused without calling it",
  () =>
    Effect.gen(function* () {
      for (const adapter of [yield* makeGmail, yield* makeOutlook, yield* makeImap]) {
        const readonly = readOnlyAdapter(adapter);
        for (const name of Object.keys(adapter)) {
          const method: unknown = Reflect.get(readonly, name);
          const original: unknown = Reflect.get(adapter, name);
          if (READ_ONLY_METHODS.some((key) => key === name))
            assert.strictEqual(method, original, name);
          else {
            assert.strictEqual(typeof method, "function", name);
            assert.notStrictEqual(method, original, name);
            assert.strictEqual(method, refused, name);
            const result = yield* refused().pipe(Effect.result);
            assert.strictEqual(result._tag, "Failure", name);
            if (result._tag === "Failure")
              assert.strictEqual(result.failure.message, READ_ONLY_MESSAGE);
            assert.strictEqual(Object.getOwnPropertyDescriptor(readonly, name)?.value, method);
          }
        }
        let invoked = false;
        const extended = {
          ...adapter,
          newWrite: () =>
            Effect.sync(() => {
              invoked = true;
            }),
        };
        const closed = readOnlyAdapter(extended);
        assert.strictEqual(Reflect.get(closed, "newWrite"), refused);
        assert.strictEqual((yield* refused().pipe(Effect.result))._tag, "Failure");
        Object.defineProperty(extended, "futureGetter", {
          configurable: true,
          enumerable: true,
          get: () => {
            invoked = true;
            return () => Effect.void;
          },
        });
        assert.strictEqual(Reflect.get(closed, "futureGetter"), refused);
        assert.strictEqual(Object.getOwnPropertyDescriptor(closed, "futureGetter")?.value, refused);
        assert.strictEqual(invoked, false);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          MemoryPlatform(),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected network request")),
          ),
        ),
      ),
    ),
);
