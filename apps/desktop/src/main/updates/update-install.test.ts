import { expect, it, vi } from "vitest";
import { approveUpdateQuit, prepareUpdateQuit, setUpdateQuitPlan } from "./update-install";
import { createQuitGuard, createShutdownHandler } from "../app/quit";

it("only an approved before-quit followed by successful window closes can prepare the update", async () => {
  approveUpdateQuit(false);
  const native = vi.fn(),
    prepare = vi.fn(async () => native),
    stop = vi.fn(() => Promise.resolve()),
    exit = vi.fn();
  const remove = setUpdateQuitPlan(prepare);
  const shutdown = createShutdownHandler({ prepareInstall: prepareUpdateQuit, stop, exit });
  let cancelWindows = true;
  const confirm = vi.fn(async () => false);
  const guard = createQuitGuard({
    pending: async () => 1,
    fallbackPending: () => 1,
    confirm,
    quit: () => {
      approveUpdateQuit();
      if (!cancelWindows) void shutdown({ preventDefault: vi.fn() });
    },
  });
  try {
    await guard({ preventDefault: vi.fn() });
    expect(await prepareUpdateQuit()).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
    confirm.mockResolvedValue(true);
    await guard({ preventDefault: vi.fn() });
    expect(native).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    cancelWindows = false;
    await shutdown({ preventDefault: vi.fn() });
    expect(prepare).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(native).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    remove();
    approveUpdateQuit(false);
  }
});
