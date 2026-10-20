import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { AtomRegistry } from "effect/reactivity";

const row = (id: string, date: number) => ({ id, threadId: id, date });
const state = vi.hoisted(() => {
  vi.resetModules();
  return {
    serverRows: [] as { id: string; threadId: string; date: number }[],
    /** Holds the `weeken*` local query until the test releases it. The mock sets both. */
    holdSlowLocal: (): void => undefined,
    releaseSlowLocal: (): void => undefined,
  };
});
vi.mock("./rpc", async () => {
  const { Context, Deferred, Effect, Layer } = await import("effect");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  let gate = Deferred.makeUnsafe<void>();
  state.holdSlowLocal = () => {
    gate = Deferred.makeUnsafe<void>();
  };
  state.releaseSlowLocal = () => {
    Effect.runSync(Deferred.succeed(gate, undefined));
  };
  const local = new Map([
    ["weeke*", Effect.succeed([row("a", 3), row("b", 2)])],
    // Answers only when the test releases it, so the server search answers first.
    ["weeken*", Effect.suspend(() => Deferred.await(gate)).pipe(Effect.as([row("a", 3)]))],
  ]);
  const call = (tag: string, payload: { query?: { search?: string; before?: number } }) => {
    if (tag === "SearchServer")
      return Effect.succeed({
        threads: state.serverRows,
        errors: state.serverRows.length ? [] : [{ accountId: "account", requiresReauth: false }],
        ignored: [],
        truncated: false,
      });
    // The inbox: one full page, then an older page that takes 300 ms.
    if (tag === "Threads" && payload.query?.search === undefined)
      return payload.query?.before === undefined
        ? Effect.succeed(Array.from({ length: 100 }, (_, i) => row(`m${i}`, 1000 - i)))
        : Effect.succeed([]).pipe(Effect.delay(300));
    return local.get(payload.query?.search ?? "") ?? Effect.succeed([]);
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
  state.holdSlowLocal();
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

type List = ReturnType<typeof threadListAtom.read>;
const ids = (list: List) => list.threads.map((t) => t.id);

/**
 * Every list on screen after the search text changes, sampled every 5 ms until `done` holds for
 * one. The last entry is the first list for which it holds.
 */
async function typed(
  registry: AtomRegistry.AtomRegistry,
  search: string | undefined,
  done: (list: List) => boolean,
) {
  if (search !== undefined) registry.set(searchTextAtom, search);
  const seen: List[] = [];
  for (;;) {
    const list = registry.get(threadListAtom);
    seen.push(list);
    if (done(list)) return seen;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}
const serverDone = (list: List) => !list.searchingServer;
const settled = (list: List) => !list.searchingServer && !list.loading;

// A failed server search has no rows, and it replaced the previous rows with an empty list for a
// frame on each keystroke until the new query's local rows arrived.
it("a failed server search keeps the previous rows while the local query loads", async () => {
  const registry = setup();
  const keep = registry.subscribe(threadListAtom, () => null);
  try {
    expect(ids((await typed(registry, "weeke", settled)).at(-1)!)).toEqual(["a", "b"]);
    expect(registry.get(threadListAtom).searchErrorAccounts).toEqual(["account"]);
    // The server search fails while the local query is still held.
    const seen = await typed(registry, "weeken", serverDone);
    expect(seen.at(-1)!.loading).toBe(true);
    expect(seen.at(-1)!.searchErrorAccounts).toEqual(["account"]);
    state.releaseSlowLocal();
    seen.push(...(await typed(registry, undefined, settled)));
    expect(seen.some((list) => list.threads.length === 0)).toBe(false);
    expect(ids(seen.at(-1)!)).toEqual(["a"]);
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
    await typed(registry, "weeke", settled);
    // The server search answers while the local query is still held.
    const during = (await typed(registry, "weeken", serverDone)).at(-1)!;
    expect(during.loading).toBe(true);
    expect(ids(during)).toEqual(["s"]);
  } finally {
    keep();
    registry.dispose();
  }
});

// The footer said "Loading older messages…" for a frame on each keystroke while the new query
// loaded its first page.
it("a new query's first page is not an older page", async () => {
  const registry = setup();
  const keep = registry.subscribe(threadListAtom, () => null);
  try {
    await typed(registry, "weeke", settled);
    registry.set(searchTextAtom, "weeken");
    const during = registry.get(threadListAtom);
    expect(during.loading).toBe(true);
    expect(during.waiting).toBe(true);
    expect(during.loadingMore).toBe(false);
  } finally {
    keep();
    registry.dispose();
  }
});

it("fetching an older page shows as loading more", async () => {
  const registry = setup();
  const keep = registry.subscribe(threadListAtom, () => null);
  try {
    await typed(registry, "", (list) => list.threads.length > 0);
    expect(registry.get(threadListAtom).threads).toHaveLength(100);
    expect(registry.get(threadListAtom).canLoadMore).toBe(true);
    registry.set(threadListAtom, undefined);
    expect(registry.get(threadListAtom).waiting).toBe(true);
    expect(registry.get(threadListAtom).loadingMore).toBe(true);
    await typed(registry, undefined, (list) => !list.waiting);
    expect(registry.get(threadListAtom).loadingMore).toBe(false);
  } finally {
    keep();
    registry.dispose();
  }
});
