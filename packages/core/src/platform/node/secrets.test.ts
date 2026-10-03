import { Effect, Fiber, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { Secrets } from "../../services.js";
const keyring = vi.hoisted(() => ({
  get: vi.fn<(signal: AbortSignal) => Promise<string | null>>(),
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    getPassword(signal: AbortSignal) {
      return keyring.get(signal);
    }
  },
}));
import { makeSecretsKeyring } from "./secrets.js";

describe("credential boundary", () => {
  it("prints the notice before calling the native keychain", async () => {
    const order: string[] = [];
    keyring.get.mockImplementation(async () => {
      order.push("read");
      return "credential";
    });
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Secrets).get("fake");
      }).pipe(
        Effect.provide(
          makeSecretsKeyring(
            Effect.sync(() => {
              order.push("notice");
            }),
          ),
        ),
      ),
    );
    expect(order).toEqual(["notice", "read"]);
    expect(value).toEqual(Option.some("credential"));
  });
  it("interrupts a keychain prompt during Layer acquisition even if native code never settles", async () => {
    let signal: AbortSignal | undefined;
    let started: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    keyring.get.mockImplementation((abort) => {
      signal = abort;
      started?.();
      return new Promise(() => {
        /* The native prompt deliberately never settles. */
      });
    });
    const waiting = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* (yield* Secrets).get("fake");
      }),
    ).pipe(Layer.provide(makeSecretsKeyring()));
    const fiber = Effect.runFork(Effect.void.pipe(Effect.provide(waiting)));
    await ready;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(signal?.aborted).toBe(true);
  });
});
