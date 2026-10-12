/**
 * Where this renderer runs. The desktop app is an Electron window; the web
 * build runs in a browser on another device, talking to the Mac over the
 * tailnet. The web entry sets this before the first render.
 */
export type Platform = "desktop" | "web";

let platform: Platform = "desktop";

export function setPlatform(next: Platform) {
  platform = next;
}

/**
 * Desktop-only abilities: separate windows, the Mac's clipboard, browser,
 * Finder, printing and native pickers. The remote server refuses these RPCs,
 * so the web build hides the controls instead of showing actions that fail.
 */
export const isDesktop = () => platform === "desktop";

/** Opens a checked http(s) URL on this device. Only for the web build. */
export function openOnDevice(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") return;
  window.open(target.href, "_blank", "noopener,noreferrer");
}

/** The authenticated download URL of one attachment part on the Mac. */
export const attachmentDownloadUrl = (messageId: string, path: readonly number[]) =>
  `/api/attachment?${new URLSearchParams({ message: messageId, part: path.join(".") }).toString()}`;
