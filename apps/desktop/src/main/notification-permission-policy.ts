import type { NotificationPermission } from "../shared/desktop";

/** Read Apple's app permission; browser-origin permissions describe a different setting. */
export function permissionStatus(value: unknown): NotificationPermission {
  switch (value) {
    case 0:
      return "notDetermined";
    case 1:
      return "denied";
    case 2:
      return "authorized";
    case 3:
      return "provisional";
    case 4:
      return "ephemeral";
    default:
      return "unknown";
  }
}
export async function readNotificationPermission(options: {
  platform: string;
  packaged: boolean;
  request: boolean;
  load: () => unknown;
}): Promise<NotificationPermission> {
  if (options.platform !== "darwin") return "unsupported";
  if (!options.packaged) return "unavailable";
  try {
    const bridge = options.load();
    if (
      typeof bridge !== "object" ||
      bridge === null ||
      !("permission" in bridge) ||
      typeof bridge.permission !== "function"
    )
      return "unknown";
    const result: unknown = await bridge.permission(options.request);
    return permissionStatus(result);
  } catch {
    return "unknown";
  }
}
export async function openNotificationSettingsWith(
  platform: string,
  open: (url: string) => Promise<unknown>,
): Promise<boolean> {
  if (platform !== "darwin") return false;
  try {
    await open("x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    return true;
  } catch {
    return false;
  }
}
