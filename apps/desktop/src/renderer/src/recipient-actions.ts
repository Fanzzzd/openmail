import { splitAddresses } from "@openmail/core/schema";
import { formatAddress, parseAddresses } from "./draft";
import type { Address } from "../../shared/api";

export const RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;
export type RecipientFieldName = (typeof RECIPIENT_FIELDS)[number];
export type RecipientFields = Record<RecipientFieldName, string>;
/** One atomic update retains unfinished text, names and quoted separators. */
export function moveRecipient(
  fields: RecipientFields,
  source: RecipientFieldName,
  target: RecipientFieldName,
  index: number,
): RecipientFields {
  if (source === target) return fields;
  const tokens = splitAddresses(fields[source])
    .map((s) => s.trim())
    .filter(Boolean);
  const token = tokens[index];
  if (!token) return fields;
  const address = parseAddresses(token).addresses[0];
  if (!address) return fields;
  const destination = splitAddresses(fields[target])
    .map((s) => s.trim())
    .filter(Boolean);
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
  return splitAddresses(value)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token, i) => (i === index ? formatAddress(address) : token.trim()))
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
