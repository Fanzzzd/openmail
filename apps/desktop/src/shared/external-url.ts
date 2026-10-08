export function hasAsciiControl(value: string, spaces = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= (spaces ? 32 : 31) || code === 127) return true;
  }
  return false;
}

/** The same policy is used for mail link hints and the OS browser boundary. */
const MAX_EXTERNAL_URL = 100_000;
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function externalUrl(value: unknown, base?: string): string | null {
  if (typeof value !== "string" || !value || value.length > MAX_EXTERNAL_URL) return null;
  // URL silently removes controls. Reject them before parsing instead.
  if (hasAsciiControl(value)) return null;
  try {
    const url = new URL(value.replaceAll(" ", "%20"), base);
    if (!EXTERNAL_SCHEMES.has(url.protocol)) return null;
    if (url.protocol === "mailto:" && url.host) return null;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}
