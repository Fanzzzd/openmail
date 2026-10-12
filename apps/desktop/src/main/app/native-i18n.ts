import { type I18n, setupI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { app } from "electron";
import { loadCatalog } from "../../shared/catalogs";
import { systemLocale } from "../../shared/locales";
export async function nativeRecoveryLabels() {
  const locale = systemLocale([...app.getPreferredSystemLanguages(), app.getLocale()]);
  const messages = await loadCatalog(locale);
  return recoveryLabels(setupI18n({ locale, messages: { [locale]: messages } }));
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
