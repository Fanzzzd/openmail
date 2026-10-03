import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { hasAsciiControl } from "../shared/external-url";
import { APP_CSP, APP_SCHEME } from "./security-policy";

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};
const within = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return (
    !!relative &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Resolve only packaged renderer assets, including symlink containment. Never fetch a network URL. */
export async function appResource(root: string, raw: string): Promise<string | null> {
  if (/(?:^|\/)(?:\.|%2e){1,2}(?=\/|$|[?#])/i.test(raw)) return null;
  if (raw.length > 8192 || hasAsciiControl(raw, true) || raw.includes("\\")) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== "app" || url.username || url.password)
      return null;
    const decoded = decodeURIComponent(url.pathname);
    if (
      hasAsciiControl(decoded) ||
      /[\\%]/u.test(decoded) ||
      decoded.split("/").some((part) => part === ".." || part === ".")
    )
      return null;
    const base = await realpath(root);
    const file = path.resolve(base, `.${decoded}`);
    if (!within(base, file) || !MIME[path.extname(file)]) return null;
    const canonical = await realpath(file);
    return within(base, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

export function appResourceHandler(root: string) {
  return async (request: Request): Promise<Response> => {
    const file = request.method === "GET" ? await appResource(root, request.url) : null;
    if (!file) return new Response(null, { status: 404 });
    try {
      return new Response(new Uint8Array(await readFile(file)), {
        headers: {
          "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
          "Content-Security-Policy": APP_CSP,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
