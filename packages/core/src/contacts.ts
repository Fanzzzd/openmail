import { Schema } from "effect";
import type { Address } from "./domain.js";

export const ContactSync = Schema.Struct({
  accountId: Schema.String,
  refreshedAt: Schema.NullOr(Schema.Number),
  attemptedAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
  scopeMissing: Schema.Boolean,
  count: Schema.Int,
});
export type ContactSync = typeof ContactSync.Type;

export const ContactGroup = Schema.Struct({
  accountId: Schema.String,
  id: Schema.String,
  name: Schema.String,
  members: Schema.Array(Schema.Struct({ name: Schema.String, address: Schema.String })),
});
export type ContactGroup = typeof ContactGroup.Type;
export const ContactPhoto = Schema.Struct({ address: Schema.String, url: Schema.String });
export type ContactPhoto = typeof ContactPhoto.Type;
export interface ContactSnapshot {
  contacts: Address[];
  groups: ContactGroup[];
  photos: ContactPhoto[];
}

/** Provider duplicates share a normalized address; keep the first nonempty name. */
export function mergeContacts(contacts: readonly Address[]): Address[] {
  const merged = new Map<string, Address>();
  for (const contact of contacts) {
    const address = contact.address.trim().toLowerCase();
    if (!/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(address)) continue;
    const previous = merged.get(address);
    merged.set(address, { address, name: previous?.name || contact.name.trim() });
  }
  return [...merged.values()];
}
