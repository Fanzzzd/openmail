import { escapeHtml } from "@openmail/core/schema";
import { app, BrowserWindow } from "electron";
import { nativeRecoveryLabels } from "./native-i18n";
import { denyNavigation } from "../security/security";
import { revealWindow } from "../windows/reveal";
import { WINDOW_SECURITY } from "../security/security-policy";

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
export const showDatabaseUpgrade = () => showDatabaseProgress("upgrading");

/** The same window while a worker checks the database after an abnormal exit. */
export async function showDatabaseProgress(kind: "upgrading" | "checking") {
  holdAppDuringUpgrade();
  const labels = await nativeRecoveryLabels();
  const window = new BrowserWindow({
    width: 440,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: labels[kind],
    webPreferences: {
      ...WINDOW_SECURITY,
      javascript: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  denyNavigation(window.webContents);
  upgradeWindows.add(window);
  const title = escapeHtml(labels[kind]);
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${title}</title><style>body{font:13px system-ui;margin:32px 36px;color:CanvasText;background:Canvas;color-scheme:light dark}p{margin:0 0 16px;font-weight:600}.track{height:6px;border-radius:3px;overflow:hidden;background:color-mix(in srgb,CanvasText 12%,transparent)}.bar{width:40%;height:100%;border-radius:3px;background:AccentColor;animation:slide 1.4s ease-in-out infinite}@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(250%)}}@media (prefers-reduced-motion:reduce){.bar{animation:none;width:100%;opacity:.5}}</style><p>${title}</p><div class="track" role="progressbar" aria-label="${title}"><div class="bar"></div></div>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  revealWindow(window);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
  return () => {
    if (!window.isDestroyed()) window.destroy();
  };
}
