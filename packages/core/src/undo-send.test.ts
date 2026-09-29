import { afterEach, assert, beforeEach, describe, it, vi } from "vitest";

import { holdSend } from "./undo-send.js";

describe("holdSend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends when the window closes, not before", () => {
    const send = vi.fn();
    holdSend(10_000, send);
    vi.advanceTimersByTime(9_999);
    assert.strictEqual(send.mock.calls.length, 0);
    vi.advanceTimersByTime(1);
    assert.strictEqual(send.mock.calls.length, 1);
  });

  it("undo at any point in the window stops the send", () => {
    for (const at of [0, 1, 5_000, 9_999]) {
      const send = vi.fn();
      const held = holdSend(10_000, send);
      vi.advanceTimersByTime(at);
      assert.isTrue(held.undo());
      vi.advanceTimersByTime(60_000);
      assert.strictEqual(send.mock.calls.length, 0, `undo after ${at} ms`);
      // A second undo has nothing left to take back.
      assert.isFalse(held.undo());
    }
  });

  it("undo after the window is too late and says so", () => {
    const send = vi.fn();
    const held = holdSend(5_000, send);
    vi.advanceTimersByTime(5_000);
    assert.isFalse(held.undo());
    assert.strictEqual(send.mock.calls.length, 1);
  });

  it("a delay of 0 sends at once with nothing to undo", () => {
    const send = vi.fn();
    const held = holdSend(0, send);
    assert.strictEqual(send.mock.calls.length, 1);
    assert.isFalse(held.undo());
  });
});
