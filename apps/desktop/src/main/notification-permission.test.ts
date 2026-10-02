import { expect, it, vi } from "vitest";
import {
  openNotificationSettingsWith,
  permissionStatus,
  readNotificationPermission,
} from "./notification-permission-policy";

it("reads Apple's authorization states and distinguishes unavailable and unreadable permission", async () => {
  expect([0, 1, 2, 3, 4, -1].map(permissionStatus)).toEqual([
    "notDetermined",
    "denied",
    "authorized",
    "provisional",
    "ephemeral",
    "unknown",
  ]);
  const native = vi.fn(() => Promise.resolve(2));
  const load = vi.fn(() => ({ permission: native }));
  expect(
    await readNotificationPermission({ platform: "darwin", packaged: true, request: false, load }),
  ).toBe("authorized");
  expect(native).toHaveBeenLastCalledWith(false);
  expect(
    await readNotificationPermission({ platform: "darwin", packaged: true, request: true, load }),
  ).toBe("authorized");
  expect(native).toHaveBeenLastCalledWith(true);
  load.mockClear();
  expect(
    await readNotificationPermission({ platform: "darwin", packaged: false, request: true, load }),
  ).toBe("unavailable");
  expect(
    await readNotificationPermission({ platform: "linux", packaged: true, request: true, load }),
  ).toBe("unsupported");
  expect(load).not.toHaveBeenCalled();
  expect(
    await readNotificationPermission({
      platform: "darwin",
      packaged: true,
      request: false,
      load: () => {
        throw new Error("missing addon");
      },
    }),
  ).toBe("unknown");
  expect(
    await readNotificationPermission({
      platform: "darwin",
      packaged: true,
      request: false,
      load: () => ({ permission: () => Promise.reject(new Error("OS failure")) }),
    }),
  ).toBe("unknown");
});
it("opens only the fixed macOS Notifications settings URL and reports failures", async () => {
  const open = vi.fn(() => Promise.resolve());
  expect(await openNotificationSettingsWith("darwin", open)).toBe(true);
  expect(open).toHaveBeenCalledWith(
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
  );
  open.mockClear();
  expect(await openNotificationSettingsWith("linux", open)).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(
    await openNotificationSettingsWith("darwin", () => Promise.reject(new Error("OS failure"))),
  ).toBe(false);
});
