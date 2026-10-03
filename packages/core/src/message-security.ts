import type { Address, MessageSecurity, Provider } from "./domain.js";
import { registrableDomain } from "./link-security.js";
import { parseAppLink } from "./system.js";

export const cleanDisplayName = (name: string) => name.replace(/\p{Cf}/gu, "");
export function senderSpoofed(sender: Address): boolean {
  return (
    cleanDisplayName(sender.name).match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}/gi) ?? []
  ).some((address) => address.toLowerCase() !== sender.address.toLowerCase());
}
export type MailHeader = { name: string; value: string };
/** Ignore delimiters and method-looking text inside RFC comments or quoted strings. */
function authenticationClauses(value: string): string[] | null {
  let text = "",
    depth = 0,
    quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if ((depth > 0 || quoted) && char === "\\") {
      i++;
      continue;
    }
    if (depth > 0) {
      if (char === "(") depth++;
      if (char === ")") depth--;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      text += " ";
      continue;
    }
    if (quoted) continue;
    if (char === "(") {
      depth++;
      text += " ";
      continue;
    }
    text += char;
  }
  return depth || quoted
    ? null
    : text
        .replace(/\r?\n\s+/g, " ")
        .split(";")
        .map((clause) => clause.trim());
}

function trustedAuthentication(
  headers: readonly MailHeader[],
  provider: Provider,
  authservId?: string | null,
): string[] {
  const index = headers.findIndex((h) => h.name.toLowerCase() === "authentication-results");
  const top = headers[index];
  if (!top) return [];
  const clauses = authenticationClauses(top.value);
  if (!clauses) return [];
  if (provider === "outlook") {
    // Microsoft omits authserv-id. Accept only its format in the first receiving-hop block.
    const received = headers.findIndex((h) => h.name.toLowerCase() === "received");
    const next = headers.findIndex((h, i) => i > received && h.name.toLowerCase() === "received");
    const hop = authenticationClauses(headers[received]?.value ?? "")?.join(";") ?? "";
    const microsoft = /\bby\s+[a-z\d.-]+\.outlook\.com\b/i.test(hop);
    return received >= 0 &&
      microsoft &&
      (next < 0 || index < next) &&
      /^(spf|dkim|dmarc)\s*=\s*[a-z]+\b/i.test(clauses[0] ?? "")
      ? clauses
      : [];
  }
  const id = clauses[0]?.toLowerCase().replace(/\s+\d+$/, "");
  return id === (provider === "gmail" ? "mx.google.com" : authservId?.toLowerCase()) &&
    (provider === "gmail" || !!authservId)
    ? clauses.slice(1)
    : [];
}

/** Only the topmost result is eligible; lower headers never establish trust. */
export function messageSecurity(
  headers: readonly MailHeader[],
  provider: Provider,
  authservId?: string | null,
): MessageSecurity {
  const clauses = trustedAuthentication(headers, provider, authservId);
  const methods = new Map<string, { result: string; clause: string }>();
  for (const clause of clauses) {
    const match = /^(spf|dkim|dmarc)\s*=\s*([a-z]+)\b/i.exec(clause);
    if (match?.[1] && match[2])
      methods.set(match[1].toLowerCase(), { result: match[2].toLowerCase(), clause });
  }
  const result = (method: string): "pass" | "fail" | "unknown" => {
    const value = methods.get(method)?.result;
    return value === "pass"
      ? "pass"
      : value === "fail" || value === "softfail" || value === "permerror"
        ? "fail"
        : "unknown";
  };
  // Without a provider-verified DKIM signature identified unambiguously and covering both list headers, use only a reviewable mail draft.
  const list = headers.filter((h) => h.name.toLowerCase() === "list-unsubscribe");
  let unsubscribe: MessageSecurity["unsubscribe"];
  if (list.length === 1) {
    for (const match of (list[0]?.value ?? "").matchAll(/<([^<>]+)>/g)) {
      const value = match[1] ?? "";
      if (value.toLowerCase().startsWith("mailto:") && parseAppLink(value)?.kind === "compose") {
        unsubscribe = { kind: "mailto", url: value };
        break;
      }
    }
  }
  const oneHeader = (name: string) => {
    const values = headers.filter((h) => h.name.toLowerCase() === name);
    return values.length === 1 ? values[0]?.value : undefined;
  };
  const from = oneHeader("from") ?? "";
  const fromDomain = /@([^\s<>]+)>?\s*$/.exec(from)?.[1]?.toLowerCase();
  const signatures = headers
    .filter((h) => h.name.toLowerCase() === "dkim-signature")
    .map(
      (h) =>
        new Map(
          h.value
            .replace(/\r?\n\s+/g, " ")
            .split(";")
            .flatMap((part) => {
              const at = part.indexOf("=");
              return at < 0
                ? []
                : [[part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()]];
            }),
        ),
    );
  const verifiedCoverage = (() => {
    const clause = methods.get("dkim")?.clause ?? "";
    if (!/^\s*dkim\s*=\s*pass\b/i.test(clause)) return false;
    const property = (name: string) =>
      new RegExp(`\\bheader\\.${name}\\s*=\\s*([^\\s;]+)`, "i")
        .exec(clause)?.[1]
        ?.replace(/^"|"$/g, "");
    const authDomain = property("d")?.toLowerCase();
    const identityDomain = property("i")?.split("@").at(-1)?.toLowerCase();
    const selector = property("s"),
      b = property("b");
    if ((!authDomain && !identityDomain) || !selector || !b || b.length < 8 || !fromDomain)
      return false;
    const matching = signatures.filter((signature) => {
      const d = signature.get("d")?.toLowerCase();
      return (
        !!d &&
        (authDomain
          ? d === authDomain
          : identityDomain === d || identityDomain?.endsWith(`.${d}`)) &&
        signature.get("s") === selector &&
        signature.get("b")?.replace(/\s/g, "").startsWith(b)
      );
    });
    const domain = matching[0]?.get("d");
    if (
      matching.length !== 1 ||
      !domain ||
      registrableDomain(domain) !== registrableDomain(fromDomain)
    )
      return false;
    const covered = new Set(
      (matching[0]?.get("h") ?? "")
        .toLowerCase()
        .split(":")
        .map((name) => name.trim()),
    );
    return (
      covered.has("from") && covered.has("list-unsubscribe") && covered.has("list-unsubscribe-post")
    );
  })();
  if (
    verifiedCoverage &&
    oneHeader("list-unsubscribe-post")?.trim().toLowerCase() === "list-unsubscribe=one-click"
  ) {
    const targets = [...(oneHeader("list-unsubscribe") ?? "").matchAll(/<([^<>]+)>/g)]
      .map((m) => m[1] ?? "")
      .filter((url) => /^https:/i.test(url));
    if (targets.length === 1) {
      try {
        const target = new URL(targets[0] ?? "");
        if (
          target.protocol === "https:" &&
          !target.username &&
          !target.password &&
          !target.hash &&
          (!target.port || target.port === "443")
        )
          unsubscribe = { kind: "post", url: target.href };
      } catch {
        /* Invalid URLs never become unsubscribe actions. */
      }
    }
  }
  return {
    dmarc: result("dmarc"),
    spf: result("spf"),
    dkim: result("dkim"),
    ...(unsubscribe ? { unsubscribe } : {}),
  };
}
