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

  it("classifies keyring errors: a missing item is None, a locked keychain retries then fails as keychain", async () => {
    const read = (key: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Secrets).get(key);
        }).pipe(Effect.provide(makeSecretsKeyring()), Effect.result),
      );
    // @napi-rs/keyring resolves undefined for NoEntry.
    keyring.get.mockResolvedValue(null);
    expect(await read("gone")).toMatchObject({ _tag: "Success", success: Option.none() });

    // errSecInteractionNotAllowed after sleep, then the Mac is unlocked.
    let calls = 0;
    keyring.get.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("User interaction is not allowed. (-25308)");
      return "refresh";
    });
    expect(await read("locked-once")).toMatchObject({
      _tag: "Success",
      success: Option.some("refresh"),
    });
    expect(calls).toBe(2);

    calls = 0;
    keyring.get.mockImplementation(async () => {
      calls++;
      throw new Error("User interaction is not allowed. (-25308)");
    });
    const locked = await read("locked");
    expect(calls).toBe(4);

    // A cancelled or denied prompt (errSecUserCanceled) is not asked again.
    calls = 0;
    keyring.get.mockImplementation(async () => {
      calls++;
      throw new Error("User canceled the operation. (-128)");
    });
    expect(await read("cancelled")).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderError", reason: "keychain" },
    });
    expect(calls).toBe(1);
    expect(locked).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ProviderError", reason: "keychain" },
    });
  });
});
