import { afterEach, expect, it, vi } from "vitest";
import { createQuitGuard, createSendState } from "./quit";

afterEach(() => vi.useRealTimers());
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

it("quit waits for confirmation, cancels cleanly and allows the resumed before-quit", async () => {
  const quit = vi.fn();
  const confirm = vi.fn(async () => false);
  const guard = createQuitGuard({
    pending: async () => 2,
    fallbackPending: () => 2,
    confirm,
    quit,
  });
  const event = { preventDefault: vi.fn() };
  const checking = guard(event);
  void guard(event);
  await checking;
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(quit).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  await guard(event);
  expect(quit).toHaveBeenCalledTimes(1);
  event.preventDefault.mockClear();
  void guard(event);
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("a lost renderer cannot leave quit waiting forever", async () => {
  vi.useFakeTimers();
  const quit = vi.fn();
  const confirm = vi.fn(async () => true);
  const guard = createQuitGuard({
    pending: () =>
      new Promise(() => {
        /* Renderer never replies. */
      }),
    fallbackPending: () => 0,
    confirm,
    quit,
  });
  void guard({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(2000);
  expect(quit).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
});

it("the timeout still asks about cached pending sends; an empty outbox quits without asking", async () => {
  vi.useFakeTimers();
  const quit = vi.fn();
  const confirm = vi.fn(async () => false);
  void createQuitGuard({
    pending: () =>
      new Promise(() => {
        /* Renderer never replies. */
      }),
    fallbackPending: () => 1,
    confirm,
    quit,
  })({ preventDefault: vi.fn() });
  await vi.advanceTimersByTimeAsync(2000);
  expect(confirm).toHaveBeenCalledOnce();
  expect(quit).not.toHaveBeenCalled();
  void createQuitGuard({ pending: async () => 0, fallbackPending: () => 0, confirm, quit })({
    preventDefault: vi.fn(),
  });
  await tick();
  expect(quit).toHaveBeenCalledOnce();
});

it("quit collects every window's latest state, removes closed/crashed windows and times out missing replies", async () => {
  vi.useFakeTimers();
  const states = createSendState();
  states.update(1, { pending: 1, undoAvailable: true });
  states.update(2, { pending: 2, undoAvailable: false });
  const snapshot = states.snapshot([
    { id: 1, request: () => states.update(1, { pending: 0, undoAvailable: false }) },
    { id: 2, request: () => states.remove(2) },
    {
      id: 3,
      request: () => {
        /* Renderer never replies. */
      },
    },
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await snapshot).toBe(0);
  expect(states.total()).toBe(0);
  expect(states.get(2)).toBeUndefined();
});

it("a reload reporting zero cannot silently discard sends held by a crashed renderer", () => {
  const states = createSendState();
  states.update(10, { pending: 1, undoAvailable: true });
  states.rendererGone(10);
  states.update(10, { pending: 0, undoAvailable: false });
  expect(states.total()).toBe(1);
  expect(states.get(10)?.pending).toBe(1);
  states.remove(10);
  expect(states.total()).toBe(0);
});
