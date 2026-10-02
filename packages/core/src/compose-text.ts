/**
 * Plain-text rules of the compose window: where the signature goes, what a
 * template's variables mean, whether the body talks about an attachment. Pure
 * functions with no Node dependencies, exported through `@openmail/core/schema`
 * so the desktop renderer and a mobile app apply the same rules.
 */
import type { Address } from "./domain.js";

/** The usenet signature separator: two dashes and a space on a line of their own. */
export const SIGNATURE_SEPARATOR = "-- ";

/**
 * Lines that start the quoted part of a reply or forward, as openmail and the
 * common clients write them. Everything from here on is someone else's text.
 */
const QUOTE_START = [
  /^.*写道：\s*$/,
  /^On .+ wrote:\s*$/,
  /^-{5,}\s*(转发的邮件|Forwarded message)\s*-{5,}\s*$/,
  /^>/,
];

function isQuoteStart(line: string): boolean {
  return QUOTE_START.some((re) => re.test(line));
}

/** Offset of the first quoted line in `body`, or its length when nothing is quoted. */
function quoteOffset(body: string): number {
  let offset = 0;
  for (const line of body.split("\n")) {
    if (isQuoteStart(line)) return offset;
    offset += line.length + 1;
  }
  return body.length;
}

/** What the person wrote: the body before their signature and before any quoted text. */
export function ownText(body: string): string {
  const own = body.slice(0, quoteOffset(body));
  const lines = own.split("\n");
  const separator = lines.findIndex((l) => l === SIGNATURE_SEPARATOR || l === "--");
  return (separator === -1 ? lines : lines.slice(0, separator)).join("\n").trim();
}

function block(signature: string): string {
  return `${SIGNATURE_SEPARATOR}\n${signature.trim()}`;
}

/** Where `sig` sits in `body` as whole lines, or -1. */
function blockIndex(body: string, sig: string): number {
  for (let at = body.indexOf(sig); at !== -1; at = body.indexOf(sig, at + 1)) {
    const end = at + sig.length;
    if ((at === 0 || body[at - 1] === "\n") && (end === body.length || body[end] === "\n")) {
      return at;
    }
  }
  return -1;
}

/**
 * Puts `next` where the signature goes, replacing `previous` if the body still
 * has it. New messages end with the signature; replies and forwards carry it
 * above the quoted text, next to what the person wrote. An empty `next`
 * removes the old one. When the body has a signature that is not `previous`
 * (typed or edited by hand), it is left alone and nothing is added.
 */
export function applySignature(
  body: string,
  previous: string | undefined,
  next: string | undefined,
): string {
  const old = previous?.trim() ? block(previous) : null;
  const replacement = next?.trim() ? block(next) : null;
  const index = old ? blockIndex(body, old) : -1;
  if (old && index !== -1) {
    const after = body.slice(index + old.length);
    if (replacement) return body.slice(0, index) + replacement + after;
    // Take the blank line before the signature with it.
    return body.slice(0, index).replace(/\n{1,2}$/, "") + after;
  }
  if (!replacement) return body;
  const at = quoteOffset(body);
  if (body.slice(0, at).split("\n").includes(SIGNATURE_SEPARATOR)) return body;
  const head = body.slice(0, at).replace(/\n+$/, "");
  // Replies keep an empty line to type on above the signature and the quote.
  return at === body.length
    ? `${head}\n\n${replacement}`
    : `${head}\n\n${replacement}\n\n${body.slice(at)}`;
}

const ATTACHMENT_WORDS =
  /附件|附上|随附|附送|附图|附表|见附|attach(ed|ment|ments|ing)?\b|enclosed|\benclosing\b/i;

/**
 * True when the person's own text (quotes and signature cut) mentions an
 * attachment. The compose window asks before sending such a message without one.
 */
export function mentionsAttachment(body: string): boolean {
  return ATTACHMENT_WORDS.test(ownText(body));
}

const CJK = /[㐀-鿿豈-﫿]/;

function nameParts(recipient: Address): { first: string; last: string; full: string } {
  const raw = recipient.name.trim();
  const full = raw || recipient.address.split("@")[0] || "";
  if (!raw) return { first: full, last: "", full };
  // "Lovelace, Ada"
  const comma = raw.split(",").map((p) => p.trim());
  if (comma.length === 2 && comma[0] && comma[1]) {
    return { first: comma[1], last: comma[0], full: `${comma[1]} ${comma[0]}` };
  }
  const words = raw.split(/\s+/);
  // Chinese names are written without spaces; the whole name is the polite form.
  if (words.length === 1 || CJK.test(raw)) return { first: raw, last: "", full: raw };
  return { first: words[0] ?? raw, last: words.at(-1) ?? "", full: raw };
}

/** Template variables and their values for one recipient. */
export function templateVariables(recipient: Address | undefined): Record<string, string> {
  if (!recipient) return { first_name: "", last_name: "", name: "", email: "" };
  const { first, last, full } = nameParts(recipient);
  return { first_name: first, last_name: last, name: full, email: recipient.address };
}

/** Replaces {first_name} and the other variables. Unknown ones stay as written. */
export function customTemplateVariables(...texts: string[]): string[] {
  const builtins = templateVariables(undefined);
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(/\{(\w+)\}/g)].flatMap((m) =>
          m[1] && !Object.hasOwn(builtins, m[1]) ? [m[1]] : [],
        ),
      ),
    ),
  ];
}

export function fillTemplate(
  text: string,
  recipient: Address | undefined,
  custom: Readonly<Record<string, string>> = {},
): string {
  const vars = { ...custom, ...templateVariables(recipient) };
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? whole) : whole,
  );
}
