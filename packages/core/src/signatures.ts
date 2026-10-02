import { Schema } from "effect";
import { type Address, type SignatureKind, type Message } from "./domain.js";
import { type SendAs } from "./organization.js";
import { richComposeBody, textComposeHtml } from "./compose-body.js";
import { applySignature, quoteOffset } from "./compose-text.js";
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
): ComposeBody {
  if (body.kind !== "rich")
    return { ...body, text: applySignature(body.text, previous?.text, next?.text) };
  const rich = (html: string) => ({
    ...richComposeBody(html),
    ...(body.font ? { font: body.font } : {}),
  });
  const block = (signature: Pick<NamedSignatureInput, "text" | "html">) =>
    richComposeBody(
      `<div>-- <br>${richComposeBody(signature.html ?? textComposeHtml(signature.text)).html}</div>`,
    ).html;
  const quote = body.text.slice(quoteOffset(body.text)).split("\n")[0] ?? "";
  const quoteIndex = quote ? body.html.indexOf(textComposeHtml(quote)) : -1;
  const blockquoteIndex = body.html.indexOf("<blockquote>");
  const quotedAt =
    [quoteIndex, blockquoteIndex].filter((index) => index >= 0).toSorted((a, b) => a - b)[0] ?? -1;
  const ownEnd = quotedAt < 0 ? body.html.length : quotedAt;
  const candidates = previous?.text.trim()
    ? [block(previous), richComposeBody(textComposeHtml(`-- \n${previous.text.trim()}`)).html]
    : [];
  const old =
    candidates.find((candidate) => {
      const at = body.html.indexOf(candidate);
      const after = at + candidate.length;
      return (
        at >= 0 &&
        after <= ownEnd &&
        (after === body.html.length ||
          /^(<br>|<\/div>)/.test(body.html.slice(after)) ||
          candidate.endsWith("</div>"))
      );
    }) ?? "";
  const replacement = next?.text.trim() ? block(next) : "";
  const at = old ? body.html.indexOf(old) : -1;
  if (at >= 0) {
    const updated = rich(body.html.slice(0, at) + replacement + body.html.slice(at + old.length));
    if (body.originalHtml === undefined) return updated;
    // A signature outside the retained remote source can change without editing that source.
    if (body.originalHtml.startsWith(old))
      return { ...updated, originalHtml: replacement + body.originalHtml.slice(old.length) };
    return body;
  }
  if (!replacement || /(?:^|\n)-- ?(?:\n|$)/.test(body.text.slice(0, quoteOffset(body.text))))
    return body;
  // Remote source stays transport-only. Its editor projection has already dropped remote images.
  if (body.originalHtml !== undefined) {
    const prefix = rich(`${replacement}<br><br>${body.html}`);
    return { ...prefix, originalHtml: `${replacement}<br><br>${body.originalHtml}` };
  }
  return rich(
    quotedAt >= 0
      ? `${body.html.slice(0, quotedAt)}${replacement}<br><br>${body.html.slice(quotedAt)}`
      : `${body.html}<br><br>${replacement}`,
  );
}
