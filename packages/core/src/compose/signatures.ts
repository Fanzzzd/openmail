import { Schema } from "effect";
import { type Address, type SignatureKind, type Message } from "../domain/domain.js";
import { type SendAs } from "../domain/organization.js";

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
