import { escapeHtml } from "@openmail/core/schema";
import { app, BrowserWindow } from "electron";
import { nativeRecoveryLabels } from "./native-i18n";

let releaseUpgradeHold: (() => void) | undefined;
/** DesktopLive calls this after its normal close handler and main window exist. */
export function finishDatabaseUpgradeStartup() {
  releaseUpgradeHold?.();
}
const keepAlive = () => {
  /* Subscribing suppresses Electron's default quit while no main window exists. */
};
function releaseHold() {
  app.off("window-all-closed", keepAlive);
  app.off("will-quit", releaseHold);
  releaseUpgradeHold = undefined;
}
function holdAppDuringUpgrade() {
  if (releaseUpgradeHold) return;
  app.on("window-all-closed", keepAlive);
  app.once("will-quit", releaseHold);
  releaseUpgradeHold = releaseHold;
}

const upgradeWindows = new WeakSet<BrowserWindow>();
export const isDatabaseUpgradeWindow = (window: BrowserWindow) => upgradeWindows.has(window);
/** Paint before core starts the worker. This window has no IPC or remote resources. */
export async function showDatabaseUpgrade() {
  holdAppDuringUpgrade();
  const labels = await nativeRecoveryLabels();
  const window = new BrowserWindow({
    width: 440,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: labels.upgrading,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  upgradeWindows.add(window);
  const title = escapeHtml(labels.upgrading);
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><style>body{font:16px system-ui;margin:40px;color:CanvasText;background:Canvas;color-scheme:light dark}progress{width:100%;margin-top:16px}</style><p>${title}</p><progress aria-label="${title}"></progress>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  window.show();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  return () => {
    if (!window.isDestroyed()) window.destroy();
  };
}
