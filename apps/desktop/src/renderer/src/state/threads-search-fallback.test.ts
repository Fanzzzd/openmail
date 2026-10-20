import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { AtomRegistry } from "effect/reactivity";

const row = (id: string, date: number) => ({ id, threadId: id, date });
const state = vi.hoisted(() => {
  vi.resetModules();
  return { serverRows: [] as { id: string; threadId: string; date: number }[] };
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer } = await import("effect");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const local: Record<string, { rows: ReturnType<typeof row>[]; delay: number }> = {
    "weeke*": { rows: [row("a", 3), row("b", 2)], delay: 0 },
    // Slower than the server search's 350 ms wait, so the server answers first.
    "weeken*": { rows: [row("a", 3)], delay: 1000 },
  };
  const call = (tag: string, payload: { query?: { search?: string } }) => {
    if (tag === "SearchServer")
      return Effect.succeed({
        threads: state.serverRows,
        errors: state.serverRows.length ? [] : [{ accountId: "account", requiresReauth: false }],
        ignored: [],
        truncated: false,
      });
    const found = local[payload.query?.search ?? ""];
    return found ? Effect.succeed(found.rows).pipe(Effect.delay(found.delay)) : Effect.succeed([]);
  };
  class MailClient extends Context.Service<MailClient, typeof call>()("test/threads-fallback") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
    static query = (tag: string, payload: { query?: { messageIds?: readonly string[] } }) =>
      Atom.make(
        AsyncResult.success(
          tag === "Threads"
            ? state.serverRows.filter((r) => payload.query?.messageIds?.includes(r.id))
            : [],
        ),
      );
  }
  return { MailClient };
});
const { threadListAtom } = await import("./threads");
const { historyAtom, locationAtom, locationOf } = await import("./location");
const { searchTextAtom } = await import("./ui");

afterAll(() => {
  vi.doUnmock("./rpc");
  vi.resetModules();
});
beforeEach(() => {
  state.serverRows = [];
});

const setup = () =>
  AtomRegistry.make({
    initialValues: [
      [locationAtom, locationOf("/mail/all/inbox")],
      [
        historyAtom,
        {
          navigate: vi.fn(),
          flush: vi.fn(),
          back: vi.fn(),
          forward: vi.fn(),
          index: () => 0,
          pushSame: vi.fn(),
          listen: () => vi.fn(),
        },
      ],
    ],
  });

/** The thread ids on screen, sampled every 5 ms for `ms` after the search text changes. */
async function typed(registry: AtomRegistry.AtomRegistry, search: string, ms: number) {
  registry.set(searchTextAtom, search);
  const seen: string[][] = [];
  for (let at = 0; at < ms; at += 5) {
    seen.push(registry.get(threadListAtom).threads.map((t) => t.id));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return seen;
}

// A failed server search has no rows, and it replaced the previous rows with an empty list for a
// frame on each keystroke until the new query's local rows arrived.
it("a failed server search keeps the previous rows while the local query loads", async () => {
  const registry = setup();
  const keep = registry.subscribe(threadListAtom, () => null);
  try {
    expect((await typed(registry, "weeke", 600)).at(-1)).toEqual(["a", "b"]);
    expect(registry.get(threadListAtom).searchErrorAccounts).toEqual(["account"]);
    const seen = await typed(registry, "weeken", 1300);
    expect(seen.some((ids) => ids.length === 0)).toBe(false);
    expect(seen.at(-1)).toEqual(["a"]);
  } finally {
    keep();
    registry.dispose();
  }
});

it("server rows replace the previous rows while the local query loads", async () => {
  state.serverRows = [row("s", 9)];
  const registry = setup();
  const keep = registry.subscribe(threadListAtom, () => null);
  try {
    await typed(registry, "weeke", 600);
    await typed(registry, "weeken", 600);
    expect(registry.get(threadListAtom).loading).toBe(true);
    expect(registry.get(threadListAtom).threads.map((t) => t.id)).toEqual(["s"]);
  } finally {
    keep();
    registry.dispose();
  }
});
