import { afterAll, expect, it, vi } from "vitest";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import type { MailboxEvent } from "../../../shared/api";

const subscriptions = vi.hoisted(() => {
  vi.resetModules();
  const state: { count: number; failFirst: "none" | "die" | "interrupt" } = {
    count: 0,
    failFirst: "none",
  };
  return state;
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer, Stream } = await import("effect");
  const { Atom } = await import("effect/reactivity");
  const events: MailboxEvent[] = [
    { _tag: "SnoozeDue", accountId: "a", ids: ["m1"], wokenAt: 1 },
    { _tag: "SyncState", state: { running: false, lastFinishedAt: 42, errors: [] } },
  ];
  const call = (tag: string) =>
    tag === "Events"
      ? Stream.suspend(() => {
          const first = subscriptions.count++ === 0;
          // A defect or interruption in the main process ends the stream without a typed error.
          if (first && subscriptions.failFirst === "die")
            return Stream.die(new Error("handler bug"));
          if (first && subscriptions.failFirst === "interrupt")
            return Stream.fromEffect(Effect.interrupt);
          return Stream.fromIterable(events);
        })
      : Effect.succeed(
          tag === "SyncState"
            ? { running: false, lastFinishedAt: null, errors: [] }
            : { status: "authorized", revision: 1 },
        );
  class MailClient extends Context.Service<MailClient, typeof call>()("test/events") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
  }
  return { MailClient };
});
import { liveUpdatesAtom, RESUBSCRIBE_MS, syncStateAtom } from "./events";
import { scaledMs, waitLimit } from "../../../../../../packages/core/test-support/test-time.js";

afterAll(() => {
  vi.doUnmock("./rpc");
  vi.resetModules();
});

it("a woken snooze reminder does not end the live update stream", async () => {
  const registry = AtomRegistry.make();
  const off = registry.subscribe(liveUpdatesAtom, () => null);
  try {
    // Reading the atom starts the subscription; events after SnoozeDue must still arrive.
    registry.get(liveUpdatesAtom);
    await vi.waitFor(() => expect(registry.get(syncStateAtom).lastFinishedAt).toBe(42), waitLimit);
    expect(AsyncResult.isSuccess(registry.get(liveUpdatesAtom))).toBe(true);
  } finally {
    off();
  }
});

for (const failure of ["die", "interrupt"] as const)
  it(`follows Events again after the stream ends with ${failure === "die" ? "a defect" : "an interruption"}`, async () => {
    subscriptions.count = 0;
    subscriptions.failFirst = failure;
    const registry = AtomRegistry.make();
    const off = registry.subscribe(liveUpdatesAtom, () => null);
    try {
      registry.get(liveUpdatesAtom);
      await vi.waitFor(() => expect(registry.get(syncStateAtom).lastFinishedAt).toBe(42), {
        timeout: scaledMs(2_000) + (RESUBSCRIBE_MS[0] ?? 0),
      });
      expect(subscriptions.count).toBe(2);
    } finally {
      off();
      subscriptions.failFirst = "none";
    }
  });
