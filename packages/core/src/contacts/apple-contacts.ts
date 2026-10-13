import { Schema } from "effect";
import type { Address } from "../domain/domain.js";
import { mergeContacts, type ContactGroup } from "./contacts.js";

export const AppleContactsStatus = Schema.Literals([
  "off",
  "unsupported",
  "notDetermined",
  "denied",
  "restricted",
  "authorized",
  "limited",
  "error",
  "waiting",
]);
export type AppleContactsStatus = typeof AppleContactsStatus.Type;
export const AppleContactsState = Schema.Struct({
  status: AppleContactsStatus,
  revision: Schema.Int,
});
export type AppleContactsState = typeof AppleContactsState.Type;
const AppleContact = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  company: Schema.String,
  emails: Schema.Array(Schema.String),
  thumbnail: Schema.NullOr(Schema.String),
});
export const AppleContactsSnapshot = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["authorized", "limited"]),
    contacts: Schema.Array(AppleContact),
    groups: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        members: Schema.Array(Schema.Struct({ id: Schema.String, address: Schema.String })),
      }),
    ),
  }),
  Schema.Struct({ status: Schema.Literals(["notDetermined", "denied", "restricted", "error"]) }),
]);
export type AppleContactsSnapshot = typeof AppleContactsSnapshot.Type;

const normalize = (address: string) => address.trim().toLowerCase();
const valid = (address: string) => /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(address);
const tokens = (value: string) => value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const matches = (query: string, value: string) => {
  const wanted = tokens(query);
  return (
    (!query.trim() || wanted.length > 0) &&
    wanted.every((token) => tokens(value).some((word) => word.startsWith(token)))
  );
};

/** Desktop-only, process-local data. Never attached to Mailbox, SQL, MCP or AI contexts. */
export function createAppleContactsCache() {
  let groups: ContactGroup[] = [];
  const byAddress = new Map<string, typeof AppleContact.Type>();
  const clear = () => {
    groups = [];
    byAddress.clear();
  };
  return {
    clear,
    replace(snapshot: AppleContactsSnapshot, photos: boolean) {
      clear();
      if (!("contacts" in snapshot)) return;
      const contacts = snapshot.contacts.map((contact) => ({
        ...contact,
        emails: [...new Set(contact.emails.map(normalize).filter(valid))],
        thumbnail:
          photos &&
          contact.thumbnail &&
          /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(contact.thumbnail) &&
          contact.thumbnail.length <= 350_000
            ? contact.thumbnail
            : null,
      }));
      const byId = new Map(contacts.map((contact) => [contact.id, contact]));
      for (const contact of contacts)
        for (const address of contact.emails)
          if (!byAddress.has(address)) byAddress.set(address, contact);
      groups = snapshot.groups.map((group) => ({
        accountId: "apple-contacts",
        id: group.id,
        name: group.name,
        // One preferred address per member; a stale distribution choice falls back to the first valid email.
        members: mergeContacts(
          [...new Map(group.members.map((member) => [member.id, member])).values()].flatMap(
            (member) => {
              const contact = byId.get(member.id);
              if (!contact) return [];
              const preferred = normalize(member.address);
              const address = contact.emails.includes(preferred) ? preferred : contact.emails[0];
              return address ? [{ name: contact.name, address }] : [];
            },
          ),
        ),
      }));
    },
    discardPhotos() {
      for (const [address, contact] of byAddress)
        byAddress.set(address, { ...contact, thumbnail: null });
    },
    identifier(address: string) {
      return byAddress.get(normalize(address))?.id ?? null;
    },
    photo(address: string) {
      return byAddress.get(normalize(address))?.thumbnail ?? null;
    },
    alternatives(address: string): Address[] {
      const contact = byAddress.get(normalize(address));
      return contact ? contact.emails.map((email) => ({ name: contact.name, address: email })) : [];
    },
    suggest(
      query: string,
      existing: readonly Address[],
      options: { hidden: readonly string[]; exclude?: string; limit?: number; available: boolean },
    ): Address[] {
      if (!options.available) return [...existing];
      const hidden = new Set(options.hidden.map(normalize));
      const allowed = (address: string) =>
        !hidden.has(address) &&
        address !== normalize(options.exclude ?? "") &&
        !/noreply|no-reply|donotreply/.test(address);
      const local = [...byAddress]
        .filter(
          ([address, contact]) =>
            allowed(address) && matches(query, `${address} ${contact.name} ${contact.company}`),
        )
        .map(([address, contact]) => ({ address, name: contact.name }));
      const enhanced = existing.map((address) => ({
        ...address,
        name: byAddress.get(normalize(address.address))?.name.trim() || address.name,
      }));
      const limit = Number.isFinite(options.limit ?? 10)
        ? Math.max(0, Math.min(100, Math.trunc(options.limit ?? 10)))
        : 10;
      return mergeContacts([...enhanced, ...local]).slice(0, limit);
    },
    groups(query: string, hidden: readonly string[], exclude?: string): ContactGroup[] {
      const blocked = new Set([...hidden, exclude ?? ""].map(normalize));
      return groups
        .filter((group) => matches(query, group.name))
        .map((group) => ({
          ...group,
          members: group.members.filter((member) => !blocked.has(member.address)),
        }))
        .filter((group) => group.members.length > 0);
    },
  };
}

const escapeVCard = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
// Fold at UTF-8 octet boundaries, without splitting a Unicode code point.
const foldVCard = (line: string) => {
  const lines: string[] = [];
  let part = "";
  let bytes = 0;
  for (const character of line) {
    const length = new TextEncoder().encode(character).length;
    if (bytes + length > 75) {
      lines.push(part);
      part = " ";
      bytes = 1;
    }
    part += character;
    bytes += length;
  }
  lines.push(part);
  return lines.join("\r\n");
};

/** vCard import leaves the final save decision to Contacts and requires no store permission. */
export function appleContactVCard(contact: Address): string {
  const address = normalize(contact.address);
  if (
    !valid(address) ||
    contact.name.includes("\r") ||
    contact.name.includes("\n") ||
    contact.name.includes(String.fromCharCode(0))
  )
    throw new Error("Invalid contact");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCard(contact.name.trim() || address)}`,
    `N:;${escapeVCard(contact.name.trim())};;;`,
    `EMAIL;TYPE=INTERNET:${escapeVCard(address)}`,
    "END:VCARD",
  ];
  return `${lines.map(foldVCard).join("\r\n")}\r\n`;
}
