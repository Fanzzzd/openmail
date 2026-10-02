import { setupI18n } from "@lingui/core";
import { app } from "electron";
import { messages as en } from "../renderer/src/locales/en/messages.po";
import { messages as zh } from "../renderer/src/locales/zh-CN/messages.po";
import { recoveryLabels } from "../renderer/src/recovery-labels";
export function nativeRecoveryLabels() {
  const locale = /^zh\b/i.test(app.getPreferredSystemLanguages()[0] ?? app.getLocale())
    ? "zh-CN"
    : "en";
  return recoveryLabels(setupI18n({ locale, messages: { en, "zh-CN": zh } }));
}
