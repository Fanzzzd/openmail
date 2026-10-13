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
      message: msg`Turn on “Allow AI to read this account” for each selected account in Settings → AI Access.`,
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
  ).toBe("Calendar access isn't granted for this account.");
  expect(
    errorText(
      i18n,
      new FeatureScopeMissing({ accountId: "fixture", feature: "settings", message: "denied" }),
    ),
  ).toBe("Sign in again to enable filters and automatic replies.");
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

it("sign-in and mail server failures say what happened from their reason, not the redacted message", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const auth = (fields: Partial<ConstructorParameters<typeof AuthError>[0]>) =>
    errorText(i18n, new AuthError({ message: "", ...fields }));
  expect(auth({ reason: "cancelled" })).toBe("Sign-in was cancelled.");
  expect(auth({ reason: "timeout" })).toMatch(/^Sign-in took too long/);
  expect(
    auth({ reason: "account_mismatch", signedInAs: "b@gmail.com", expected: "a@gmail.com" }),
  ).toBe("You signed in as b@gmail.com. Sign in with a@gmail.com to continue.");
  const provider = (reason: ConstructorParameters<typeof ProviderError>[0]["reason"]) =>
    errorText(i18n, new ProviderError({ message: "", ...(reason ? { reason } : {}) }));
  expect(provider("dns")).toMatch(/^Can't find the mail server/);
  expect(provider("refused")).toMatch(/refused the connection/);
  expect(provider("timeout")).toMatch(/didn.t respond/);
  expect(provider("unreachable")).toMatch(/didn.t respond/);
  expect(provider("tls")).toMatch(/secure connection/);
  expect(provider("unsafe_login")).toMatch(/authorization code/);
  expect(provider(undefined)).toBe("Can't reach the mail server right now.");
});
