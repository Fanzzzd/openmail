import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ packaged: false, register: vi.fn(() => true) }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return native.packaged;
    },
    isDefaultProtocolClient: () => false,
    setAsDefaultProtocolClient: native.register,
  },
}));
import { becomeDefaultClient, defaultClientStatus } from "./default-client";
it("development cannot register the bare Electron binary", () => {
  expect(defaultClientStatus()).toEqual({ available: false, isDefault: false });
  expect(becomeDefaultClient()).toBe(false);
  expect(native.register).not.toHaveBeenCalled();
  native.packaged = true;
  expect(becomeDefaultClient()).toBe(true);
  expect(native.register).toHaveBeenCalledWith("mailto");
});
