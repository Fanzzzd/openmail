import { afterAll, expect, it, vi } from "vitest";
import { AtomRegistry } from "effect/reactivity";

const calls = vi.hoisted(() => {
  vi.resetModules();
  return { queries: [] as string[] };
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer } = await import("effect");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const call = (tag: string) => {
    if (tag === "SearchServer")
      return Effect.succeed({ threads: [], errors: [], ignored: [], truncated: false });
    return Effect.succeed([]);
  };
  class MailClient extends Context.Service<MailClient, typeof call>()("test/threads-query") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
    static query = (tag: string) => {
      calls.queries.push(tag);
      return Atom.make(AsyncResult.success(tag === "ThreadCount" ? 0 : []));
    };
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

it("counts the mailbox, but not a search, which shows no count", () => {
  const registry = setup();
  const unsubscribe = registry.subscribe(threadListAtom, () => null);
  try {
    calls.queries.length = 0;
    registry.set(searchTextAtom, "");
    registry.get(threadListAtom);
    expect(calls.queries).toContain("ThreadCount");
    calls.queries.length = 0;
    registry.set(searchTextAtom, "invoice");
    registry.get(threadListAtom);
    expect(calls.queries).not.toContain("ThreadCount");
  } finally {
    unsubscribe();
    registry.dispose();
  }
});
