import { Schema } from "effect";
import { type Address, type SignatureKind, type Message } from "./domain.js";
import { type SendAs } from "./organization.js";
import { richComposeBody, textComposeHtml } from "./compose-body.js";
import {
  applySignature,
  quoteOffset,
  DEFAULT_SIGNATURE_OPTIONS,
  type SignatureOptions,
} from "./compose-text.js";
import type { ComposeBody } from "./compose-body.js";

export const NamedSignatureInput = Schema.Struct({
  address: Schema.String,
  name: Schema.String,
  text: Schema.String,
  html: Schema.optionalKey(Schema.String),
});
export type NamedSignatureInput = typeof NamedSignatureInput.Type;
export const NamedSignature = Schema.Struct({
  id: Schema.String,
  ...NamedSignatureInput.fields,
  source: Schema.Literals(["local", "gmail"]),
});
export type NamedSignature = typeof NamedSignature.Type;
export const SignatureDefault = Schema.Struct({
  address: Schema.String,
  kind: Schema.Literals(["new", "reply"]),
  signatureId: Schema.NullOr(Schema.String),
});
export type SignatureDefault = typeof SignatureDefault.Type;
/** Saved ids lead; new or removed ids do not perturb the remaining library order. */
export function orderedSignatures(
  library: readonly NamedSignature[],
  order: readonly string[],
): NamedSignature[] {
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return library.toSorted((a, b) => rank(a.id) - rank(b.id));
}
export const gmailSignatureId = (address: string) => `gmail:${address.toLowerCase()}`;

/** Only verified aliases reach SendAs. Never choose an identity from a different account. */
export function replyFromAddress(
  received: Pick<Message, "from" | "to" | "cc" | "labels">,
  account: { readonly id: string; readonly email: string },
  aliases: readonly SendAs[],
  preference: "received" | "default",
): Address {
  const senders = aliases.filter((s) => s.accountId === account.id);
  const fallback = senders.find((s) => s.isDefault) ?? { address: account.email, name: "" };
  if (preference === "received") {
    const own = (address: string): Address | undefined => {
      const alias = senders.find((s) => s.address.toLowerCase() === address.toLowerCase());
      if (alias) return { name: alias.name, address: alias.address };
      return address.toLowerCase() === account.email.toLowerCase()
        ? {
            name:
              fallback.address.toLowerCase() === account.email.toLowerCase() ? fallback.name : "",
            address: account.email,
          }
        : undefined;
    };
    if (received.labels.includes("SENT")) {
      const sender = own(received.from.address);
      if (sender) return sender;
    }
    for (const recipient of [...received.to, ...received.cc]) {
      const sender = own(recipient.address);
      if (sender) return sender;
    }
  }
  return { name: fallback.name, address: fallback.address };
}

export function signatureDefault(
  library: readonly NamedSignature[],
  defaults: readonly SignatureDefault[],
  address: string,
  kind: SignatureKind,
): NamedSignature | undefined {
  const key = address.toLowerCase();
  const setting = defaults.find((d) => d.address === key && d.kind === kind);
  const fallback =
    library.find((s) => s.address === key && s.id === `legacy:${key}:${kind}`)?.id ??
    gmailSignatureId(key);
  return library.find(
    (s) => s.address === key && s.id === (setting ? setting.signatureId : fallback),
  );
}

/** Uses the editor sanitizer for every insertion. Authored formatting outside the signature survives. */
export function applyComposeSignature(
  body: ComposeBody,
  previous: Pick<NamedSignatureInput, "text" | "html"> | undefined,
  next: Pick<NamedSignatureInput, "text" | "html"> | undefined,
  options: SignatureOptions = DEFAULT_SIGNATURE_OPTIONS,
): ComposeBody {
  if (body.kind !== "rich")
    return { ...body, text: applySignature(body.text, previous?.text, next?.text, options) };
  const rich = (html: string) => ({
    ...richComposeBody(html),
    ...(body.font ? { font: body.font } : {}),
  });
  const block = (
    signature: Pick<NamedSignatureInput, "text" | "html">,
    separator = options.signatureSeparator,
  ) =>
    richComposeBody(
      `<div>${separator ? "-- <br>" : ""}${richComposeBody(signature.html ?? textComposeHtml(signature.text)).html}</div>`,
    ).html;
  const quote = body.text.slice(quoteOffset(body.text)).split("\n")[0] ?? "";
  const quoteIndex = quote ? body.html.indexOf(textComposeHtml(quote)) : -1;
  const blockquoteIndex = body.html.indexOf("<blockquote>");
  const quotedAt =
    [quoteIndex, blockquoteIndex].filter((index) => index >= 0).toSorted((a, b) => a - b)[0] ?? -1;
  const ownEnd = quotedAt < 0 ? body.html.length : quotedAt;
  const candidates = previous?.text.trim()
    ? [
        block(previous, true),
        block(previous, false),
        richComposeBody(textComposeHtml(`-- \n${previous.text.trim()}`)).html,
      ]
    : [];
  const candidateAt = (candidate: string) => {
    for (
      let index = body.html.indexOf(candidate);
      index >= 0;
      index = body.html.indexOf(candidate, index + 1)
    ) {
      const end = index + candidate.length;
      // A prior below-quote signature is replaceable only at the end, never inside a quote.
      const prefix = body.html.slice(0, index);
      const belowQuote =
        prefix.endsWith("</blockquote><br><br>") ||
        (options.signaturePosition === "below" && prefix.endsWith("<br><br>"));
      if (end <= ownEnd || (belowQuote && /^(?:<br>|<\/div>|\s)*$/.test(body.html.slice(end))))
        return index;
    }
    return -1;
  };
  const old = candidates.find((candidate) => candidateAt(candidate) >= 0) ?? "";
  const replacement = next?.text.trim() ? block(next) : "";
  const at = old ? candidateAt(old) : -1;
  if (at >= 0) {
    if (next && quotedAt >= 0 && at < quotedAt !== (options.signaturePosition === "above")) {
      const removed = applyComposeSignature(body, previous, undefined, options);
      return removed === body ? body : applyComposeSignature(removed, undefined, next, options);
    }
    const updated = rich(body.html.slice(0, at) + replacement + body.html.slice(at + old.length));
    if (body.originalHtml === undefined) return updated;
    // A signature outside the retained remote source can change without editing that source.
    if (body.originalHtml.startsWith(old))
      return { ...updated, originalHtml: replacement + body.originalHtml.slice(old.length) };
    if (body.originalHtml.endsWith(old))
      return { ...updated, originalHtml: body.originalHtml.slice(0, -old.length) + replacement };
    return body;
  }
  if (!replacement || /(?:^|\n)-- ?(?:\n|$)/.test(body.text.slice(0, quoteOffset(body.text))))
    return body;
  // Remote source stays transport-only. Its editor projection has already dropped remote images.
  if (body.originalHtml !== undefined) {
    if (options.signaturePosition === "below") {
      const suffix = rich(`${body.html}<br><br>${replacement}`);
      return { ...suffix, originalHtml: `${body.originalHtml}<br><br>${replacement}` };
    }
    const prefix = rich(`${replacement}<br><br>${body.html}`);
    return { ...prefix, originalHtml: `${replacement}<br><br>${body.originalHtml}` };
  }
  return rich(
    quotedAt >= 0 && options.signaturePosition === "above"
      ? `${body.html.slice(0, quotedAt)}${replacement}<br><br>${body.html.slice(quotedAt)}`
      : `${body.html}<br><br>${replacement}`,
  );
}
