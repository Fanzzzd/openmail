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
  unknown: msg`Sync couldn't finish. It will retry automatically.`,
  // The same sentences the app shows for these connection failures elsewhere.
  dns: msg`Can't find the mail server. Check the server name and your internet connection.`,
  refused: msg`The mail server refused the connection. Check the port.`,
  no_response: msg`The mail server didn't respond. Check the server name, the port and your internet connection.`,
  tls: msg`Couldn't set up a secure connection to the mail server. Check the port and the encryption setting.`,
  unsafe_login: msg`The server blocked the sign-in as unsafe. Turn on IMAP in your email's web settings, then sign in with the authorization code it generates.`,
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
