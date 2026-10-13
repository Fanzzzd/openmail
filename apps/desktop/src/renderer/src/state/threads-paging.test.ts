import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterAll, expect, it, vi } from "vitest";
import { AtomRegistry } from "effect/reactivity";
import { pagedList } from "./threads";
import { waitLimit } from "../../../../../../packages/core/test-support/test-time.js";
const calls = vi.hoisted(() => {
  vi.resetModules();
  return { older: vi.fn() };
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer } = await import("effect");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const call = (tag: string) => {
    if (tag === "FetchOlder") {
      calls.older();
      return Effect.fail(new Error("Offline"));
    }
    return Effect.succeed([]);
  };
  class MailClient extends Context.Service<MailClient, typeof call>()("test/fixture-paging") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
    static query = () => Atom.make(AsyncResult.success([]));
  }
  return { MailClient };
});

afterAll(() => {
  vi.doUnmock("./rpc");
  vi.resetModules();
});
it("failed Load older waits for a new user request across list refreshes", async () => {
  const registry = AtomRegistry.make();
  const { loaded, wanted } = pagedList({ mailbox: "inbox" });
  const unsubscribe = registry.subscribe(loaded, () => null);
  try {
    await vi.waitFor(() => expect(registry.get(loaded)._tag).toBe("Success"), waitLimit);
    registry.set(wanted, 2);
    await vi.waitFor(() => expect(registry.get(loaded)._tag).toBe("Failure"), waitLimit);
    expect(calls.older).toHaveBeenCalledTimes(1);
    registry.refresh(loaded);
    await vi.waitFor(() => expect(registry.get(loaded).waiting).toBe(false), waitLimit);
    expect(calls.older).toHaveBeenCalledTimes(1);
    registry.refresh(loaded);
    await vi.waitFor(() => expect(registry.get(loaded).waiting).toBe(false), waitLimit);
    expect(calls.older).toHaveBeenCalledTimes(1);
    registry.set(wanted, 3);
    await vi.waitFor(() => expect(calls.older).toHaveBeenCalledTimes(2), waitLimit);
  } finally {
    unsubscribe();
    registry.dispose();
  }
});

it("keeps a mounted list after garbage collection", async () => {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  if (typeof gc !== "function") throw new Error("gc is unavailable");
  const registry = AtomRegistry.make();
  const query = { mailbox: "sent" } as const;
  // Only the registry holds the atom, as when the list is on screen.
  const unsubscribe = registry.subscribe(pagedList(query).loaded, () => null);
  const mounted = new WeakRef(pagedList(query).loaded);
  try {
    for (let i = 0; i < 3; i++) {
      Reflect.apply(gc, undefined, []);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
    // A collected family member would start a second list from page one.
    expect(pagedList(query).loaded).toBe(mounted.deref());
  } finally {
    unsubscribe();
    registry.dispose();
  }
});
