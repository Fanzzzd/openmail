import { splitAddresses } from "@openmail/core/schema";
import { formatAddress, parseAddresses } from "./draft";
import type { Address } from "../../shared/api";

const RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;
export type RecipientFieldName = (typeof RECIPIENT_FIELDS)[number];
type RecipientFields = Record<RecipientFieldName, string>;
/** The addresses in the field, trimmed, in order. */
export const recipientTokens = (text: string) =>
  splitAddresses(text)
    .map((part) => part.trim())
    .filter(Boolean);
/** One atomic update retains unfinished text, names and quoted separators. */
export function moveRecipient(
  fields: RecipientFields,
  source: RecipientFieldName,
  target: RecipientFieldName,
  index: number,
): RecipientFields {
  if (source === target) return fields;
  const tokens = recipientTokens(fields[source]);
  const token = tokens[index];
  if (!token) return fields;
  const address = parseAddresses(token).addresses[0];
  if (!address) return fields;
  const destination = recipientTokens(fields[target]);
  const exists = parseAddresses(fields[target]).addresses.some(
    (a) => a.address.toLowerCase() === address.address.toLowerCase(),
  );
  return {
    ...fields,
    [source]: tokens.filter((_, i) => i !== index).join(", "),
    [target]: [...destination, ...(exists ? [] : [token])].join(", "),
  };
}
export function replaceRecipient(value: string, index: number, address: Address): string {
  return recipientTokens(value)
    .map((token, i) => (i === index ? formatAddress(address) : token))
    .filter(Boolean)
    .join(", ");
}
export interface RecipientDrag {
  source: RecipientFieldName;
  index: number;
  text: string;
}
export function parseRecipientDrag(raw: string): RecipientDrag | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("source" in value) ||
    !("index" in value) ||
    !("text" in value)
  )
    return null;
  if (
    (value.source !== "to" && value.source !== "cc" && value.source !== "bcc") ||
    typeof value.index !== "number" ||
    !Number.isSafeInteger(value.index) ||
    value.index < 0 ||
    typeof value.text !== "string"
  )
    return null;
  return { source: value.source, index: value.index, text: value.text };
}
export const RECIPIENT_MIME = "application/x-openmail-recipient";
