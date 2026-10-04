import { getDomain } from "tldts";
import punycode from "punycode.js";
// The userland package is CommonJS: Node ESM supports its default export only.
// oxlint-disable-next-line import/no-named-as-default-member -- Node ESM cannot import named exports from this CJS package.
const { toUnicode } = punycode;

export const registrableDomain = (host: string) =>
  getDomain(host, { allowPrivateDomains: true }) ?? host.toLowerCase().replace(/\.$/, "");
const trackingKey = /^(utm_.*|fbclid|gclid|mc_eid|mc_cid)$/i;
const signatureKey = /^(x-amz-.*|signature|sig|token|hmac|expires|key-pair-id|policy)$/i;
const queryKey = (part: string) => {
  try {
    return decodeURIComponent(part.split("=")[0] ?? "");
  } catch {
    return part.split("=")[0] ?? "";
  }
};
export function cleanLink(url: string, enabled = true): string {
  if (!enabled || !/^https?:/i.test(url)) return url;
  const question = url.indexOf("?"),
    hash = url.indexOf("#");
  if (question < 0 || (hash >= 0 && hash < question)) return url;
  const end = hash < 0 ? url.length : hash;
  const parts = url.slice(question + 1, end).split("&");
  if (parts.some((part) => signatureKey.test(queryKey(part)))) return url;
  const kept = parts.filter((part) => !trackingKey.test(queryKey(part)));
  if (kept.length === parts.length) return url;
  return url.slice(0, question) + (kept.length ? `?${kept.join("&")}` : "") + url.slice(end);
}
export function linkIdentity(
  value: string,
): { ascii: string; unicode: string; domain: string; suspicious: boolean } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const ascii = url.hostname;
    const unicode = toUnicode(ascii);
    const scripts = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u].filter(
      (pattern) => pattern.test(unicode),
    );
    return {
      ascii,
      unicode,
      domain: registrableDomain(ascii),
      suspicious: /(?:^|\.)xn--/i.test(ascii) || scripts.length > 1,
    };
  } catch {
    return null;
  }
}
const normalizedLabel = (label: string) =>
  label
    .normalize("NFKC")
    .replace(/[\u3002\uFF0E\uFF61]/g, ".")
    .replace(/\p{Cf}/gu, "");
function displayMismatches(
  identity: NonNullable<ReturnType<typeof linkIdentity>>,
  label: string,
): boolean {
  const text = normalizedLabel(label);
  const tokens =
    text.match(
      /https?:\/\/[^\s<>"']+|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}(?::\d+)?(?:\/[^\s<>"']*)?/giu,
    ) ?? [];
  return tokens.some((token) => {
    const cleaned = token.replace(/[.,!?;:）)\]}>]+$/u, "");
    const displayed = linkIdentity(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
    return !!displayed && displayed.domain !== identity.domain;
  });
}
/** Domain mismatch is independent of an internationalized target's own warning. */
export function linkDisplayMismatch(href: string, label: string): boolean {
  const identity = linkIdentity(href);
  if (!identity) return false;
  const text = normalizedLabel(label)
    .trim()
    .replace(/[.,!?;:）)\]}>]+$/u, "");
  // Corpus counters require the whole visible label to be a URL/domain. The reader
  // still checks embedded domain tokens through displayMismatches below.
  if (
    !/^(?:https?:\/\/[^\s<>"']+|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}(?::\d+)?(?:[/?#][^\s<>"']*)?)$/iu.test(
      text,
    )
  )
    return false;
  const displayed = linkIdentity(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  return displayed !== null && displayed.domain !== identity.domain;
}
export function linkNeedsConfirmation(href: string, label: string): boolean {
  const identity = linkIdentity(href);
  return identity !== null && (identity.suspicious || displayMismatches(identity, label));
}
export function linkHint(value: string): string {
  const identity = linkIdentity(value);
  return identity && identity.unicode !== identity.ascii
    ? `${identity.unicode} (${identity.ascii}) — ${value}`
    : value;
}
