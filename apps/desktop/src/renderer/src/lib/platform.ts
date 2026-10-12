import { type MailTag, remoteDisposition } from "../../../shared/remote-policy";

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

/**
 * Whether this window can call `tag`. The Mac can call any RPC; the web build
 * only those in the remote table, which the Mac's remote server enforces. Gate
 * a control on the RPC it calls, so a newly denied RPC hides its control too.
 */
export const canCall = (tag: MailTag) => isDesktop() || remoteDisposition(tag) !== "denied";

/**
 * The web build on a phone or tablet: a finger, no keyboard to speak of. The
 * same condition as the `coarse:` CSS variant. A laptop browser is web but not touch.
 */
export const isTouchWeb = () =>
  !isDesktop() && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** Opens a checked http(s) URL on this device. Only for the web build. */
export function openOnDevice(url: string) {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") return;
  window.open(target.href, "_blank", "noopener,noreferrer");
}

/** The authenticated download URL of one attachment part on the Mac. */
export const attachmentDownloadUrl = (messageId: string, path: readonly number[]) =>
  `/api/attachment?${new URLSearchParams({ message: messageId, part: path.join(".") }).toString()}`;
