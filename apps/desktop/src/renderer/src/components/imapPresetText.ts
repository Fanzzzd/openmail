import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

/**
 * UI text for core's IMAP presets, keyed by preset id. Core keeps its own
 * Chinese `note` for the CLI; the app shows these instead and falls back to
 * core's text for a preset it does not know.
 */

/** Preset names that are not plain brand names. */
export const PRESET_NAMES: Record<string, MessageDescriptor> = {
  qq: msg`QQ Mail`,
  "163": msg`163 Mail`,
};

/** The line under the password field: where to create the app password. */
export const PRESET_NOTES: Record<string, MessageDescriptor> = {
  icloud: msg`Create an app-specific password under Sign-In and Security in your Apple Account.`,
  yahoo: msg`Create an app password under Account Security in your Yahoo account.`,
  qq: msg`On the web, turn on IMAP/SMTP under Settings > Account & Security > Security Settings, then generate an authorization code.`,
  "163": msg`On the web, turn on IMAP under Settings > POP3/SMTP/IMAP, then follow the prompts to generate an authorization code.`,
  fastmail: msg`Create an app password under Settings > Privacy & Security, with IMAP and SMTP checked.`,
};
