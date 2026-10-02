import { app, shell } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import {
  readNotificationPermission,
  openNotificationSettingsWith,
} from "./notification-permission-policy";
const require = createRequire(import.meta.url);
export const notificationPermission = (request = false) =>
  readNotificationPermission({
    platform: process.platform,
    packaged: app.isPackaged,
    request,
    load: () => require(path.join(process.resourcesPath, "native/notification-permissions.node")),
  });
export const openNotificationSettings = () =>
  openNotificationSettingsWith(process.platform, (url) => shell.openExternal(url));
