import { describe, expect, it } from "vitest";
import { setupI18n } from "@lingui/core";
import { InvalidInput, PermanentError, ProviderError } from "@openmail/core/schema";

import { PUBLIC_ERROR_MESSAGES } from "../../../shared/public-error-messages";
import { INPUT_ERRORS, errorText } from "./errors";

describe("input error translations", () => {
  it("only translate messages the main process lets through", () => {
    expect(
      Object.keys(INPUT_ERRORS).filter((message) => !PUBLIC_ERROR_MESSAGES.has(message)),
    ).toEqual([]);
  });

  it("translate every message the main process lets through", () => {
    const english = setupI18n({ locale: "en", messages: { en: {} } });
    const generic = "Something went wrong. Please try again.";
    const raw = [...PUBLIC_ERROR_MESSAGES].filter(
      (message) =>
        message !== "the operation failed." &&
        message !== "no printers are available." &&
        message !== "Contacts operation failed." &&
        !INPUT_ERRORS[message],
    );
    expect(raw).toEqual([]);
    expect(errorText(english, new InvalidInput({ message: "Queued delivery is paused" }))).toBe(
      generic,
    );
  });

  it("end every message with a period and name the next step", () => {
    const english = setupI18n({ locale: "en", messages: { en: {} } });
    const texts = Object.values(INPUT_ERRORS).map((descriptor) => english._(descriptor));
    expect(texts.filter((text) => !/[.?!]$/.test(text))).toEqual([]);
    for (const [message, text] of [
      [
        "Calendar response was not sent",
        "Your response wasn't sent. Try again, or respond from your calendar.",
      ],
      ["Unknown label or folder", "This label or folder no longer exists. Refresh the list."],
      [
        "Too many tailnet logins",
        "Remote access allows up to 64 tailnet logins. Remove some, then save again.",
      ],
      ["Unsupported server rule", "OpenMail can't edit this server filter. Edit it in webmail."],
    ] as const)
      expect(errorText(english, new InvalidInput({ message }))).toBe(text);
  });

  it("explain internal calendar failures with a next step", () => {
    const english = setupI18n({ locale: "en", messages: { en: {} } });
    for (const message of [
      "Calendar pagination repeated a page",
      "Invalid calendar pagination link",
    ])
      expect(errorText(english, new InvalidInput({ message }))).toBe(
        "Couldn't load the calendar from the server. Try again in a few minutes.",
      );
    expect(
      errorText(english, new InvalidInput({ message: "Cannot build calendar response" })),
    ).toBe("Couldn't prepare a reply to this invitation. Respond from your calendar instead.");
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
