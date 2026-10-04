import { recipientLabel } from "./recipients.js";
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
export function quoteOffset(body: string): number {
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

export interface SignatureOptions {
  readonly signaturePosition: "above" | "below";
  readonly signatureSeparator: boolean;
}
export const DEFAULT_SIGNATURE_OPTIONS: SignatureOptions = {
  signaturePosition: "above",
  signatureSeparator: true,
};
function block(signature: string, separator = true): string {
  return `${separator ? `${SIGNATURE_SEPARATOR}\n` : ""}${signature.trim()}`;
}

/** Where `sig` sits in `body` as whole lines, or -1. */
function blockIndex(
  body: string,
  sig: string,
  position: SignatureOptions["signaturePosition"],
): number {
  const quoted = quoteOffset(body);
  for (let at = body.indexOf(sig); at !== -1; at = body.indexOf(sig, at + 1)) {
    const end = at + sig.length;
    if ((at === 0 || body[at - 1] === "\n") && (end === body.length || body[end] === "\n")) {
      if (at < quoted) return at;
      if (position === "below" && end === body.length && body.slice(0, at).endsWith("\n\n"))
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
  options: SignatureOptions = DEFAULT_SIGNATURE_OPTIONS,
): string {
  const old = previous?.trim()
    ? ([block(previous), block(previous, false)].find(
        (candidate) => blockIndex(body, candidate, options.signaturePosition) >= 0,
      ) ?? null)
    : null;
  const replacement = next?.trim() ? block(next, options.signatureSeparator) : null;
  const index = old ? blockIndex(body, old, options.signaturePosition) : -1;
  if (old && index !== -1) {
    const after = body.slice(index + old.length);
    if (replacement) {
      const quoted = quoteOffset(body);
      if (quoted < body.length && index < quoted !== (options.signaturePosition === "above"))
        return applySignature(
          body.slice(0, index).replace(/\n{1,2}$/, "") + after,
          undefined,
          next,
          options,
        );
      return body.slice(0, index) + replacement + after;
    }
    // Take the blank line before the signature with it.
    return body.slice(0, index).replace(/\n{1,2}$/, "") + after;
  }
  if (!replacement) return body;
  const at = options.signaturePosition === "below" ? body.length : quoteOffset(body);
  if (body.slice(0, quoteOffset(body)).split("\n").includes(SIGNATURE_SEPARATOR)) return body;
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

export const TEMPLATE_VARIABLES = [
  "first_name",
  "last_name",
  "name",
  "email",
  "recipient_first_name",
  "recipient_last_name",
  "recipient_name",
  "recipient_email",
  "sender_first_name",
  "sender_last_name",
  "sender_name",
  "sender_email",
  "date",
  "time",
  "day",
  "month",
  "year",
  "subject",
  "to",
  "cc",
  "bcc",
] as const;
export interface TemplateContext {
  readonly sender?: Address;
  readonly now?: Date;
  readonly locale?: string;
  readonly subject?: string;
  readonly to?: readonly Address[];
  readonly cc?: readonly Address[];
  readonly bcc?: readonly Address[];
}
const templateAddresses = (list: readonly Address[] | undefined) =>
  (list ?? []).map((a) => recipientLabel(a, true)).join(", ");
/** The legacy four recipient variables are retained for saved templates. */
export function templateVariables(
  recipient: Address | undefined,
  context?: TemplateContext,
): Record<string, string> {
  const names = recipient ? nameParts(recipient) : { first: "", last: "", full: "" };
  const base = {
    first_name: names.first,
    last_name: names.last,
    name: names.full,
    email: recipient?.address ?? "",
  };
  if (context === undefined) return base;
  const sender = context.sender ? nameParts(context.sender) : { first: "", last: "", full: "" };
  const date = context.now ?? new Date();

  return {
    ...base,
    recipient_first_name: names.first,
    recipient_last_name: names.last,
    recipient_name: names.full,
    recipient_email: base.email,
    sender_first_name: sender.first,
    sender_last_name: sender.last,
    sender_name: sender.full,
    sender_email: context.sender?.address ?? "",
    date: date.toLocaleDateString(context.locale),
    time: date.toLocaleTimeString(context.locale, { hour: "2-digit", minute: "2-digit" }),
    day: String(date.getDate()),
    month: String(date.getMonth() + 1),
    year: String(date.getFullYear()),
    subject: context.subject ?? "",
    to: templateAddresses(context.to),
    cc: templateAddresses(context.cc),
    bcc: templateAddresses(context.bcc),
  };
}
export function customTemplateVariables(...texts: string[]): string[] {
  const builtins = new Set<string>(TEMPLATE_VARIABLES);
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(/\{(\w+)\}/g)].flatMap((m) =>
          m[1] && !builtins.has(m[1]) ? [m[1]] : [],
        ),
      ),
    ),
  ];
}
/** Unknown variables stay literal and values are substituted once. */
export function fillTemplate(
  text: string,
  recipient: Address | undefined,
  custom: Readonly<Record<string, string>> = {},
  context?: TemplateContext,
): string {
  const vars = { ...custom, ...templateVariables(recipient, context) };
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.hasOwn(vars, key) ? (vars[key] ?? whole) : whole,
  );
}
