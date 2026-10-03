import { afterAll, expect, it, vi } from "vitest";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
const calls = vi.hoisted(() => {
  vi.resetModules();
  return { queries: new Array<{ tag: string; payload: unknown }>() };
});
vi.mock("../rpc", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    MailClient: {
      query: (tag: string, payload: unknown) => {
        calls.queries.push({ tag, payload });
        return Atom.make(AsyncResult.initial());
      },
    },
  };
});
vi.mock("./apple-contacts", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return { appleContactsStatusAtom: Atom.make(AsyncResult.initial()) };
});
import { threadAtom, draftStatusAtom } from "./queries";
afterAll(() => {
  vi.doUnmock("../rpc");
  vi.doUnmock("./apple-contacts");
  vi.resetModules();
});

it("local draft selection resolves to an empty thread without querying message RPCs", () => {
  calls.queries = [];
  const registry = AtomRegistry.make();
  try {
    for (const id of ["draft:fake-uuid", "draft:new-local"])
      expect(AsyncResult.getOrElse(registry.get(threadAtom(id)), () => null)).toEqual([]);
    expect(calls.queries).toEqual([]);
    threadAtom("gmail:fake/message");
    expect(calls.queries).toEqual([{ tag: "Thread", payload: { id: "gmail:fake/message" } }]);
    expect(threadAtom(null)).not.toBe(threadAtom("draft:fake-uuid"));
  } finally {
    registry.dispose();
  }
});

it("composer save status uses a local optional draft query rather than OpenDraft import", () => {
  calls.queries = [];
  draftStatusAtom("draft:never-saved");
  expect(calls.queries).toEqual([{ tag: "DraftStatus", payload: { id: "draft:never-saved" } }]);
});
