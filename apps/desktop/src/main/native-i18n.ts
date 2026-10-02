import { setupI18n } from "@lingui/core";
import { app } from "electron";
import { loadCatalog } from "../shared/catalogs";
import { systemLocale } from "../shared/locales";
import { recoveryLabels } from "../renderer/src/recovery-labels";
export async function nativeRecoveryLabels() {
  const locale = systemLocale([...app.getPreferredSystemLanguages(), app.getLocale()]);
  const messages = await loadCatalog(locale);
  return recoveryLabels(setupI18n({ locale, messages: { [locale]: messages } }));
}
