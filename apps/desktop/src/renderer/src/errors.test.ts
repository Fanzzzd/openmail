import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";
import { InvalidInput, PermanentError, ProviderError } from "@openmail/core/schema";

import { PUBLIC_ERROR_MESSAGES } from "../../shared/public-error-messages";
import { INPUT_ERRORS, errorText } from "./errors";

describe("input error translations", () => {
  it("only translate messages the main process lets through", () => {
    expect(
      Object.keys(INPUT_ERRORS).filter((message) => !PUBLIC_ERROR_MESSAGES.has(message)),
    ).toEqual([]);
  });
});

it("fixed Outlook errors use the selected locale for validation and provider failures", () => {
  const text =
    "Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.";
  const descriptor = INPUT_ERRORS[text];
  if (!descriptor) throw new Error("Missing Outlook error descriptor");
  const translated = "Outlook.com 消息上限为 25 MB，包含消息文本和附件。请移除部分附件后发送。";
  const i18n = setupI18n({
    locale: "zh-CN",
    messages: { "zh-CN": { [descriptor.id]: translated } },
  });
  for (const error of [
    new InvalidInput({ message: text }),
    new PermanentError({ message: text }),
    new ProviderError({ message: text }),
  ])
    expect(errorText(i18n, error)).toBe(translated);
});
