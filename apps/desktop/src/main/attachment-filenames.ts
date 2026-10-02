import { attachmentFilename } from "@openmail/core/schema";
import path from "node:path";
/** Files that run code when opened. They can be saved, but not opened from the app. */
export const EXECUTABLE =
  /\.(webloc|inetloc|fileloc|url|mobileconfig|action|definition|prefPane|saver|osax|shortcut|appex|app|command|tool|sh|bash|zsh|csh|ksh|pkg|mpkg|dmg|scpt|scptd|applescript|workflow|terminal|jar|exe|msi|bat|cmd|com|scr|ps1|vbs|js|jse|wsf|hta|lnk|reg|dll|so|dylib|py|pl|rb|php)$/i;

/** A filename that stays inside the folder it is written to. */
export function safeFilename(name: string): string {
  const base = path
    .basename(name.replaceAll("\\", "/"))
    .replace(/[/:]/g, "_")
    .replaceAll(/./gsu, (c) => (c.charCodeAt(0) < 32 ? "_" : c))
    .replace(/^\.+/, "")
    .trim();
  return attachmentFilename(base || "attachment");
}
