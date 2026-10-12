import { afterAll, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import type { AppleContactsState } from "@openmail/core/schema";
import { Keys } from "./keys";

const calls = vi.hoisted(() => {
  vi.resetModules();
  const state: AppleContactsState = { status: "authorized", revision: 1 };
  return { state, polls: vi.fn(), contacts: ["private@example.com"], queries: vi.fn() };
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer } = await import("effect");
  const { Atom } = await import("effect/reactivity");
  const call = () =>
    Effect.sync(() => {
      calls.polls();
      return { ...calls.state };
    });
  class MailClient extends Context.Service<MailClient, typeof call>()("test/apple-status") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
  }
  return { MailClient };
});
import { MailClient } from "./rpc";
import { appleContactsStatusAtom } from "./apple-contacts";

afterAll(() => {
  vi.doUnmock("./rpc");
  vi.resetModules();
});

it("polled revocation and cache revisions invalidate mounted contacts without recursively polling status", async () => {
  const registry = AtomRegistry.make();
  const contacts = MailClient.runtime
    .atom(
      Effect.sync(() => {
        calls.queries();
        return [...calls.contacts];
      }),
    )
    .pipe(Atom.withReactivity([Keys.contacts]));
  const offContacts = registry.subscribe(contacts, () => null);
  const offStatus = registry.subscribe(appleContactsStatusAtom, () => null);
  try {
    await vi.waitFor(() =>
      expect(AsyncResult.getOrElse(registry.get(contacts), () => [])).toEqual([
        "private@example.com",
      ]),
    );
    await vi.waitFor(() =>
      expect(AsyncResult.getOrElse(registry.get(appleContactsStatusAtom), () => null)?.status).toBe(
        "authorized",
      ),
    );
    const initialQueries = calls.queries.mock.calls.length;
    calls.state = { status: "denied", revision: 2 };
    calls.contacts = [];
    registry.refresh(appleContactsStatusAtom);
    await vi.waitFor(() =>
      expect(AsyncResult.getOrElse(registry.get(appleContactsStatusAtom), () => null)?.status).toBe(
        "denied",
      ),
    );
    await vi.waitFor(() =>
      expect(AsyncResult.getOrElse(registry.get(contacts), () => ["stale"])).toEqual([]),
    );
    expect(calls.queries.mock.calls.length).toBeGreaterThan(initialQueries);
    expect(calls.polls).toHaveBeenCalledTimes(2);
    const queries = calls.queries.mock.calls.length;
    registry.refresh(appleContactsStatusAtom);
    await vi.waitFor(() => expect(calls.polls).toHaveBeenCalledTimes(3));
    expect(calls.queries).toHaveBeenCalledTimes(queries);
    calls.state = { status: "denied", revision: 3 };
    calls.contacts = ["new@example.com"];
    registry.refresh(appleContactsStatusAtom);
    await vi.waitFor(() =>
      expect(AsyncResult.getOrElse(registry.get(contacts), () => [])).toEqual(["new@example.com"]),
    );
    expect(calls.polls).toHaveBeenCalledTimes(4);
  } finally {
    offStatus();
    offContacts();
    registry.dispose();
  }
});
