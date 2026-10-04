import { afterAll, expect, it, vi } from "vitest";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import type { MailboxEvent } from "../../../shared/api";

vi.hoisted(() => vi.resetModules());
vi.mock("../rpc", async () => {
  const { Context, Effect, Layer, Stream } = await import("effect");
  const { Atom } = await import("effect/reactivity");
  const events: MailboxEvent[] = [
    { _tag: "SnoozeDue", accountId: "a", ids: ["m1"], wokenAt: 1 },
    { _tag: "SyncState", state: { running: false, lastFinishedAt: 42, errors: [] } },
  ];
  const call = (tag: string) =>
    tag === "Events"
      ? Stream.fromIterable(events)
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
import { liveUpdatesAtom, syncStateAtom } from "./events";

afterAll(() => {
  vi.doUnmock("../rpc");
  vi.resetModules();
});

it("a woken snooze reminder does not end the live update stream", async () => {
  const registry = AtomRegistry.make();
  const off = registry.subscribe(liveUpdatesAtom, () => null);
  try {
    // Reading the atom starts the subscription; events after SnoozeDue must still arrive.
    registry.get(liveUpdatesAtom);
    await vi.waitFor(() => expect(registry.get(syncStateAtom).lastFinishedAt).toBe(42));
    expect(AsyncResult.isSuccess(registry.get(liveUpdatesAtom))).toBe(true);
  } finally {
    off();
  }
});
