import { app } from "electron";

export const defaultClientStatus = () => ({
  available: app.isPackaged,
  isDefault: app.isPackaged && app.isDefaultProtocolClient("mailto"),
});
export const becomeDefaultClient = () => app.isPackaged && app.setAsDefaultProtocolClient("mailto");
