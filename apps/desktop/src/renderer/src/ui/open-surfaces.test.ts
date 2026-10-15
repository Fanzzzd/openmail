// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { closeSheet, useOpenSurface } from "./open-surfaces";

afterEach(cleanup);

it("Close window over a sheet closes the newest surface, then other sheets, then the window", () => {
  const first = vi.fn<() => void>();
  const second = vi.fn<() => void>();
  const closeWindow = vi.fn<() => void>();
  const one = renderHook(() => useOpenSurface(true, first));
  const two = renderHook(() => useOpenSurface(true, second));

  closeSheet(closeWindow);
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  act(() => two.unmount());

  closeSheet(closeWindow, () => true);
  expect(first).toHaveBeenCalledOnce();
  act(() => one.unmount());

  const closeOther = vi.fn(() => true);
  closeSheet(closeWindow, closeOther);
  expect(closeOther).toHaveBeenCalledOnce();
  expect(closeWindow).not.toHaveBeenCalled();
});

it("Close window with nothing left to close closes the window", () => {
  const closeWindow = vi.fn<() => void>();
  closeSheet(closeWindow);
  expect(closeWindow).toHaveBeenCalledOnce();
  closeSheet(closeWindow, () => false);
  expect(closeWindow).toHaveBeenCalledTimes(2);
});

it("a closed surface no longer catches Close window", () => {
  const close = vi.fn<() => void>();
  const closeWindow = vi.fn<() => void>();
  const surface = renderHook(({ open }) => useOpenSurface(open, close), {
    initialProps: { open: true },
  });
  surface.rerender({ open: false });
  closeSheet(closeWindow);
  expect(close).not.toHaveBeenCalled();
  expect(closeWindow).toHaveBeenCalledOnce();
  surface.unmount();
});
