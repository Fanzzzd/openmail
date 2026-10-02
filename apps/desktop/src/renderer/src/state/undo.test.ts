import { expect, it, vi } from "vitest";
import { act, createElement, useEffect } from "react";
import type { ToastState } from "../components/Toast";
import { testDom } from "../test-dom";

const state = vi.hoisted(() => {
  const calls: { id: string; targets: readonly string[] }[] = [];
  return {
    fail: false,
    calls,
    reads: 0,
    history: new Array<{ undoId: string; createdAt: number }>(),
  };
});
vi.mock("./mail", async () => {
  const { Effect } = await import("effect");
  const { InvalidInput } = await import("@openmail/core/schema");
  return {
    useRunMail: () => Effect.runSync,
    withMail: () =>
      Effect.sync(() => {
        state.reads++;
        return state.history;
      }),
    undoBatch: (id: string, targets: readonly string[]) => {
      state.calls.push({ id, targets });
      return state.fail
        ? Effect.fail(new InvalidInput({ message: "retry" }))
        : Effect.sync(() => {
            state.history = state.history.filter((entry) => entry.undoId !== id);
          });
    },
  };
});
import { useBatchUndo } from "./undo";

it("reader results set the same toast/Undo command; failed undo can retry and completed undo runs once", () => {
  const dom = testDom();
  state.calls = [];
  state.fail = false;
  const notify = vi.fn<(toast: Omit<ToastState, "id">) => void>();
  const clearToast = vi.fn();
  const restored = vi.fn();
  let handler: ReturnType<typeof useBatchUndo> | undefined;
  function Harness() {
    const current = useBatchUndo({
      notify,
      clearToast,
      label: "Undo",
      failureText: () => "Failed",
    });
    useEffect(() => {
      handler = current;
    }, [current]);
    return null;
  }
  try {
    dom.render(createElement(Harness));
    if (!handler) throw new Error("Missing undo hook");
    for (const kind of ["archive", "trash", "star", "read", "unread-from"]) {
      handler.showUndo({ undoId: kind }, ["chosen"], kind, restored);
      const toast = notify.mock.calls.at(-1)?.[0];
      expect(toast?.text).toBe(kind);
      expect(toast?.action?.run).toBe(handler.undoRef.current);
      state.fail = true;
      act(() => handler?.undoRef.current?.());
      const retry = notify.mock.calls.at(-1)?.[0];
      expect(retry?.tone).toBe("error");
      expect(retry?.action?.run).toBe(handler.undoRef.current);
      state.fail = false;
      act(() => retry?.action?.run());
      expect(handler.undoRef.current).toBeNull();
      act(() => retry?.action?.run());
      expect(state.calls.filter((call) => call.id === kind)).toEqual([
        { id: kind, targets: ["chosen"] },
        { id: kind, targets: ["chosen"] },
      ]);
    }
    expect(restored).toHaveBeenCalledTimes(5);
    expect(clearToast).toHaveBeenCalledTimes(5);
  } finally {
    dom.dispose();
  }
});

it("restored history is fetched once and never rebinds Cmd+Z after undo-send clears it", () => {
  const dom = testDom();
  state.calls = [];
  state.reads = 0;
  state.history = [{ undoId: "old", createdAt: Date.now() }];
  const notify = vi.fn<(toast: Omit<ToastState, "id">) => void>();
  let handler: ReturnType<typeof useBatchUndo> | undefined;
  function Harness() {
    const current = useBatchUndo({
      notify: (toast) => notify(toast),
      clearToast: vi.fn(),
      label: "Undo",
      failureText: () => "Failed",
    });
    useEffect(() => {
      handler = current;
    });
    return null;
  }
  try {
    dom.render(createElement(Harness));
    expect(notify).not.toHaveBeenCalled();
    expect(handler?.undoRef.current).toBeNull();
    dom.render(createElement(Harness));
    if (handler) handler.undoRef.current = null;
    dom.render(createElement(Harness));
    expect(state.reads).toBe(1);
    expect(notify).not.toHaveBeenCalled();
    expect(handler?.undoRef.current).toBeNull();
  } finally {
    dom.dispose();
  }
});

it("an explicit history action preserves the current undo-send command and never binds an old batch", () => {
  const dom = testDom();
  state.calls = [];
  state.fail = false;
  state.reads = 0;
  state.history = [{ undoId: "old", createdAt: Date.now() }];
  let handler: ReturnType<typeof useBatchUndo> | undefined;
  function Harness() {
    const current = useBatchUndo({
      notify: vi.fn(),
      clearToast: vi.fn(),
      label: "Undo",
      failureText: () => "Failed",
    });
    useEffect(() => {
      handler = current;
    });
    return null;
  }
  try {
    dom.render(createElement(Harness));
    if (!handler) throw new Error("Missing hook");
    const undoSend = vi.fn();
    handler.undoRef.current = undoSend;
    act(() => {
      void handler?.undoRestored("old");
    });
    expect(state.calls).toEqual([{ id: "old", targets: [] }]);
    expect(handler.undoRef.current).toBe(undoSend);
    expect(state.reads).toBe(1);
  } finally {
    dom.dispose();
  }
});
