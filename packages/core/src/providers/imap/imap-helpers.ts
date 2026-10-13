export interface Flags {
  unread: boolean;
  starred: boolean;
}
import { Option } from "effect";
import { decodeProviderId } from "./imap-cursor.js";

export const copyProgressKey = (providerId: string, destination: string, accepted = false) =>
  JSON.stringify(accepted ? [providerId, destination, "accepted"] : [providerId, destination]);

export const retainedResetLabels = (labels: readonly string[]) =>
  labels.filter((label) => ["UNREAD", "STARRED", "IMPORTANT"].includes(label));

export const IMAP_SPECIAL_LABELS: Record<string, string> = {
  "\\Inbox": "INBOX",
  "\\Sent": "SENT",
  "\\Drafts": "DRAFT",
  "\\Junk": "SPAM",
  "\\Trash": "TRASH",
  "\\Archive": "ARCHIVE",
};

export function flagsOf(flags: Iterable<string> | undefined): Flags {
  const values = new Set(flags);
  return { unread: !values.has("\\Seen"), starred: values.has("\\Flagged") };
}

/** Decode once at the boundary and group valid IDs by folder and UIDVALIDITY. */
export function groupIdsByFolder(ids: readonly string[]) {
  const groups = new Map<
    string,
    { path: string; uidValidity: string; ids: [string, ...string[]]; uids: [number, ...number[]] }
  >();
  for (const id of ids) {
    const decoded = decodeProviderId(id);
    if (Option.isNone(decoded)) return Option.none();
    const ref = decoded.value;
    const key = JSON.stringify([ref.path, ref.uidValidity]);
    const group = groups.get(key);
    if (group) {
      group.ids.push(id);
      group.uids.push(ref.uid);
    } else
      groups.set(key, { path: ref.path, uidValidity: ref.uidValidity, ids: [id], uids: [ref.uid] });
  }
  return Option.some(groups);
}
