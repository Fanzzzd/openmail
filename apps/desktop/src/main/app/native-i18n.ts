import { type I18n, setupI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { app } from "electron";
import type { Language } from "@openmail/core/schema";
import { loadCatalog } from "../../shared/catalogs";
import { type Locale, systemLocale } from "../../shared/locales";

const osLocale = () => systemLocale([...app.getPreferredSystemLanguages(), app.getLocale()]);
async function nativeI18n(locale: Locale = osLocale()) {
  const messages = await loadCatalog(locale);
  return setupI18n({ locale, messages: { [locale]: messages } });
}

export async function nativeRecoveryLabels() {
  return recoveryLabels(await nativeI18n());
}

/** The language setting, as of the last sign-in the app started. */
let appLanguage: Language = "system";
export function setNativeLanguage(language: Language) {
  appLanguage = language;
}

/** The browser page after an OAuth sign-in, in the app's language. Core escapes it. */
export async function nativeAuthorizePage() {
  const i18n = await nativeI18n(appLanguage === "system" ? undefined : appLanguage);
  return {
    lang: i18n.locale,
    title: i18n._(msg`OpenMail sign-in`),
    doneText: i18n._(msg`Signed in. You can close this page and go back to OpenMail.`),
    failedText: i18n._(msg`Sign-in failed. Go back to OpenMail and try again.`),
  };
}

/** Shared catalog for native recovery dialogs, available before the mailbox starts. */
function recoveryLabels(i18n: I18n) {
  return {
    locale: i18n.locale,
    upgrading: i18n._(msg`Upgrading local database…`),
    checking: i18n._(msg`Checking local database…`),
    upgradeSpaceTitle: i18n._(msg`More disk space is needed`),
    upgradeSpaceDetail: (size: string) =>
      i18n._(
        msg`Free at least ${size} MiB to upgrade the local database, then restart OpenMail. The database was kept.`,
      ),
    newerDatabaseTitle: i18n._(msg`This library was opened by a newer OpenMail`),
    newerDatabaseDetail: i18n._(
      msg`Update OpenMail to the latest version to open it. The library was not changed.`,
    ),
    safeMode: i18n._(msg`OpenMail safe mode`),
    integrityFailed: i18n._(msg`The local database could not be verified`),
    crashDetail: i18n._(
      msg`OpenMail stopped unexpectedly three times within five minutes. Continue, reset the local mail cache and re-sync, or quit. Accounts, drafts and keychain tokens are kept.`,
    ),
    integrityDetail: i18n._(
      msg`The database integrity check (quick_check) failed or the file is unavailable. Reset rebuilds a damaged database from readable local records and keeps the original file. Keychain tokens are kept.`,
    ),
    continue: i18n._(msg`Continue`),
    reset: i18n._(msg`Reset local cache`),
    quit: i18n._(msg`Quit`),
    recovered: i18n._(msg`The local database was recovered`),
    recoveredDetail: (backup: string, copied: number, skipped: number) =>
      i18n._(
        msg`Recovered ${copied} local records. Skipped ${skipped} unreadable items. Original database: ${backup}`,
      ),
    inUse: i18n._(
      msg`Close other OpenMail processes (CLI/MCP), then restart this app and try recovery again.`,
    ),
    interrupted: (backup: string) =>
      i18n._(
        msg`Database recovery was interrupted. Restore a preserved database before reopening OpenMail. Preserved database: ${backup}`,
      ),
    resetFailed: i18n._(msg`Could not reset the local cache`),
    resetFailedDetail: i18n._(
      msg`The database was kept. Quit OpenMail and restore a local backup or contact support.`,
    ),
  };
}
