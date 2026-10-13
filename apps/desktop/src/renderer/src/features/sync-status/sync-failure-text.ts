import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  isKeychainLocked,
  storedSyncFailureReason,
  type SyncFailureReason,
} from "@openmail/core/schema";

const TEXT: Record<SyncFailureReason, MessageDescriptor> = {
  quota: msg`The mail provider is limiting requests. Sync will try again later.`,
  auth: msg`The server rejected the sign-in.`,
  network: msg`Can't reach the mail server right now.`,
  server: msg`The mail server had a problem. Sync will try again later.`,
  unknown: msg`Sync could not finish. It will retry automatically.`,
};
const KEYCHAIN = msg`Keychain is locked`;

/**
 * Fixed, translated text for a stored sync error. Core stores one sentence per reason; anything
 * else (raw provider text an older version stored) shows the generic sentence, never itself.
 */
export function syncErrorText(i18n: I18n, stored: string): string {
  if (isKeychainLocked(stored)) return i18n._(KEYCHAIN);
  return i18n._(TEXT[storedSyncFailureReason(stored)]);
}
