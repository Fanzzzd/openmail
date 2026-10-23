import { afterAll, expect, it, vi } from "vitest";
import { AtomRegistry, Reactivity } from "effect/reactivity";
import type { View } from "../lib/view";
import { waitLimit } from "../../../../../../packages/core/test-support/test-time.js";

const calls = vi.hoisted(() => {
  vi.resetModules();
  return { threads: [] as string[], release: [] as (() => void)[] };
});
vi.mock("./rpc", async () => {
  const { Context, Effect, Layer } = await import("effect");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  // Each list request waits until the test releases it.
  const call = (_tag: string, payload?: { query?: { mailbox?: string } }) =>
    Effect.callback<readonly never[]>((resume) => {
      calls.threads.push(payload?.query?.mailbox ?? "");
      calls.release.push(() => resume(Effect.succeed([])));
    });
  class MailClient extends Context.Service<MailClient, typeof call>()("test/view-warming") {
    static runtime = Atom.runtime(Layer.succeed(MailClient, call));
    static query = () => Atom.make(AsyncResult.success([]));
  }
  return { MailClient };
});
import { MailClient } from "./rpc";
import { Keys } from "./keys";
import { INPUT_QUIET_MS, type WarmClock, warmViews } from "./view-warming";

afterAll(() => {
  vi.doUnmock("./rpc");
  vi.resetModules();
});

const view = (mailbox: View["mailbox"]): View => ({ space: "all", mailbox });

/** A clock the test moves by hand; idle callbacks and timers run on `tick`. */
function manualClock() {
  let now = 10_000;
  let tasks: { at: number; run: () => void }[] = [];
  const clock: WarmClock = {
    now: () => now,
    idle: (run) => clock.after(0, run),
    after: (ms, run) => {
      const task = { at: now + ms, run };
      tasks.push(task);
      return () => {
        tasks = tasks.filter((t) => t !== task);
      };
    },
  };
  const tick = (ms: number) => {
    now += ms;
    for (;;) {
      const due = tasks.filter((t) => t.at <= now);
      if (due.length === 0) return;
      tasks = tasks.filter((t) => t.at > now);
      for (const t of due) t.run();
    }
  };
  return { clock, tick };
}

it("warming sends one list at a time, waits out recent input, and skips cached lists", async () => {
  const registry = AtomRegistry.make();
  const { clock, tick } = manualClock();
  let lastInput = 9_500;
  const stop = warmViews(
    registry,
    [view("starred"), view("sent"), view("drafts")],
    () => lastInput,
    clock,
  );
  try {
    // A click half a second ago: nothing loads until the window has been quiet for a second.
    tick(100);
    expect(calls.threads).toEqual([]);
    tick(INPUT_QUIET_MS);
    expect(calls.threads).toEqual(["starred"]);
    // The next list waits for this one.
    tick(5000);
    expect(calls.threads).toEqual(["starred"]);
    calls.release.shift()?.();
    await vi.waitFor(() => {
      tick(300);
      expect(calls.threads).toEqual(["starred", "sent"]);
    }, waitLimit);
    // Input during the pass delays the next list again.
    lastInput = clock.now();
    calls.release.shift()?.();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    tick(300);
    expect(calls.threads).toEqual(["starred", "sent"]);
    tick(INPUT_QUIET_MS);
    expect(calls.threads).toEqual(["starred", "sent", "drafts"]);
    calls.release.shift()?.();
  } finally {
    stop();
  }
  // A change makes the cached lists stale; a second pass does not reload them.
  calls.threads.length = 0;
  registry.set(
    MailClient.runtime.fn(() => Reactivity.invalidate([Keys.threads])),
    undefined,
  );
  const again = warmViews(registry, [view("starred"), view("sent")], () => 0, clock);
  tick(5000);
  expect(calls.threads).toEqual([]);
  again();
  registry.dispose();
});

it("stopping a pass cancels the views it has not started", () => {
  const registry = AtomRegistry.make();
  const { clock, tick } = manualClock();
  calls.threads.length = 0;
  const stop = warmViews(registry, [view("spam"), view("trash")], () => 0, clock);
  tick(10);
  expect(calls.threads).toEqual(["spam"]);
  stop();
  calls.release.shift()?.();
  tick(10_000);
  expect(calls.threads).toEqual(["spam"]);
  registry.dispose();
});
