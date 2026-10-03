import { setupI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  AuthError,
  ProviderError,
  PermanentError,
  FeatureScopeMissing,
  SettingsScopeMissing,
  InvalidInput,
} from "@openmail/core/schema";
import { expect, it } from "vitest";
import { errorText } from "./errors";

it("AI settings InvalidInput errors use the selected UI locale", () => {
  const cases = [
    { message: msg`Enter a single API key.`, translated: "请输入单个 API 密钥。" },
    { message: msg`Invalid AI account settings.`, translated: "AI 账户设置无效。" },
    {
      message: msg`Could not save the API key in the system keychain.`,
      translated: "无法将 API 密钥存入系统钥匙串。",
    },
    {
      message: msg`Allow sending mail text for each selected account in AI settings.`,
      translated: "请在 AI 设置中授权所选账户发送邮件文本。",
    },
  ];
  const i18n = setupI18n({
    locale: "zh-CN",
    messages: {
      "zh-CN": Object.fromEntries(cases.map(({ message, translated }) => [message.id, translated])),
    },
  });
  for (const { message, translated } of cases) {
    expect(errorText(i18n, new InvalidInput({ message: String(message.message) }))).toBe(
      translated,
    );
  }
});

it("redacted errors keep their fixed localized category rather than a generic failure", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  expect(errorText(i18n, new ProviderError({ message: "the operation failed." }))).toBe(
    "Can't reach the mail server right now.",
  );
  expect(errorText(i18n, new AuthError({ message: "the operation failed." }))).toBe(
    "The server rejected the sign-in.",
  );
  expect(errorText(i18n, new PermanentError({ message: "the operation failed." }))).toBe(
    "The server refused this action.",
  );
  expect(
    errorText(
      i18n,
      new FeatureScopeMissing({
        accountId: "fixture",
        feature: "calendar",
        message: "the operation failed.",
      }),
    ),
  ).toBe("Sign in again to access your calendar.");
  expect(
    errorText(
      i18n,
      new SettingsScopeMissing({ accountId: "fixture", message: "the operation failed." }),
    ),
  ).toBe("Sign in again to enable filters and automatic replies.");
});

it("missing OAuth configuration survives redaction and gives a setup instruction", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  expect(errorText(i18n, new ProviderError({ message: "", reason: "configuration" }))).toBe(
    "OAuth client not configured. Set it up before syncing.",
  );
});
