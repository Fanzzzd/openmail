import { act, createElement, useEffect, useLayoutEffect, useRef } from "react";
import { DEFAULT_PREFS, type Prefs, type SwipeAction } from "@openmail/core/schema";
import { expect, it, vi } from "vitest";
import { testDom } from "./test-dom";
import { useMessageSwipe } from "./message-swipe-hook";

function GestureHost({
  onSwipe,
  actions,
  onPreview,
}: {
  onSwipe: (action: SwipeAction) => void;
  actions: Prefs["swipeActions"];
  onPreview: (distance: number) => void;
}) {
  const rowRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    rowRef.current = document.querySelector<HTMLButtonElement>("#gesture-host");
    return () => {
      rowRef.current = null;
    };
  }, []);
  const preview = useMessageSwipe(rowRef, actions, onSwipe);
  useEffect(() => {
    onPreview(preview.distance);
  }, [preview, onPreview]);
  return createElement("button", { type: "button", id: "gesture-host" });
}

it("rerendering preserves the gesture and latest handler; preference cleanup resets preview", () => {
  const dom = testDom();
  vi.useFakeTimers();
  const first = vi.fn(),
    second = vi.fn(),
    onPreview = vi.fn();
  const render = (onSwipe: typeof first, actions = DEFAULT_PREFS.swipeActions) =>
    dom.render(createElement(GestureHost, { onSwipe, actions, onPreview }));
  const wheel = (row: Element) =>
    act(() => {
      const event = new dom.window.Event("wheel", { cancelable: true });
      Object.defineProperties(event, {
        deltaX: { value: 80 },
        deltaY: { value: 0 },
        deltaMode: { value: 0 },
      });
      row.dispatchEvent(event);
    });
  try {
    render(first);
    const row = dom.element.querySelector("button");
    if (!row) throw new Error("Missing gesture host");
    wheel(row);
    expect(onPreview).toHaveBeenLastCalledWith(-80);
    render(second);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith("archive");
    expect(onPreview).toHaveBeenLastCalledWith(0);
    wheel(row);
    render(second, { ...DEFAULT_PREFS.swipeActions, leftShort: "none" });
    expect(onPreview).toHaveBeenLastCalledWith(0);
    act(() => {
      vi.advanceTimersByTime(180);
    });
    expect(second).toHaveBeenCalledTimes(1);
  } finally {
    dom.dispose();
    vi.useRealTimers();
  }
});
