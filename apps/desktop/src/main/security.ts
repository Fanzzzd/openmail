import type { IpcMainEvent, Session, WebContents, WebFrameMain } from "electron";
import { developmentPage, isAppPage } from "./security-policy";

type AppWindowKind = "main" | "compose" | "thread" | "message";
const renderers = new Map<WebContents, { kind: AppWindowKind; devPage: string | null }>();

export function trustRenderer(
  contents: WebContents,
  kind: AppWindowKind,
  packaged: boolean,
  devUrl?: string,
) {
  renderers.set(contents, { kind, devPage: developmentPage(packaged, devUrl) });
  contents.once("destroyed", () => renderers.delete(contents));
}

/** For windows that never navigate: file drops, redirects, frames, popups and webviews. */
export function denyNavigation(contents: Pick<WebContents, "on" | "setWindowOpenHandler">): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
}

/** Only a registered app window's top frame can call the mailbox RPCs. */
export function trustedSender(
  event: Pick<IpcMainEvent, "sender"> & {
    senderFrame: Pick<WebFrameMain, "frameTreeNodeId" | "url"> | null;
  },
): boolean {
  const renderer = renderers.get(event.sender);
  return (
    !!renderer &&
    !event.sender.isDestroyed() &&
    event.sender.getType() === "window" &&
    !!event.senderFrame &&
    Number.isSafeInteger(event.senderFrame.frameTreeNodeId) &&
    event.senderFrame.frameTreeNodeId >= 0 &&
    event.senderFrame.frameTreeNodeId === event.sender.mainFrame.frameTreeNodeId &&
    isAppPage(event.sender.mainFrame.url, renderer.devPage) &&
    isAppPage(event.senderFrame.url, renderer.devPage)
  );
}

/** Origin comparison cannot use URL.origin: Node reports "null" for custom schemes. */
function sameOrigin(origin: string, page: string): boolean {
  try {
    const url = new URL(origin);
    const app = new URL(page);
    return url.protocol === app.protocol && url.host === app.host && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function mayWriteClipboard(
  contents: WebContents | null,
  details: { isMainFrame: boolean; requestingUrl?: string },
  origin?: string,
): boolean {
  if (
    !contents ||
    contents.isDestroyed() ||
    !details.isMainFrame ||
    !trustedSender({ sender: contents, senderFrame: contents.mainFrame })
  )
    return false;
  const page = contents.mainFrame.url;
  if (
    details.requestingUrl &&
    (!sameOrigin(details.requestingUrl, page) ||
      new URL(details.requestingUrl).pathname !== new URL(page).pathname)
  )
    return false;
  if (origin && !sameOrigin(origin, page)) return false;
  return !!(details.requestingUrl || origin);
}

/** Only the application session needs browser clipboard writes. Notifications remain native. */
export function configurePermissions(
  ses: Pick<
    Session,
    "setPermissionRequestHandler" | "setPermissionCheckHandler" | "setDevicePermissionHandler"
  >,
  allowClipboard = false,
) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(
      allowClipboard &&
        permission === "clipboard-sanitized-write" &&
        mayWriteClipboard(contents, details),
    ),
  );
  ses.setPermissionCheckHandler(
    (contents, permission, origin, details) =>
      allowClipboard &&
      permission === "clipboard-sanitized-write" &&
      mayWriteClipboard(contents, details, origin),
  );
  ses.setDevicePermissionHandler(() => false);
}
