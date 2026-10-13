import { setupI18n } from "@lingui/core";
import { SYNC_FAILURE_TEXT } from "@openmail/core/schema";
import { expect, it } from "vitest";
import { syncErrorText } from "./sync-failure-text";

it("IMAP connection failures keep the sentence that says what to check", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  expect(syncErrorText(i18n, `imap:me@example.org: ${SYNC_FAILURE_TEXT.tls}`)).toBe(
    "Couldn't set up a secure connection to the mail server. Check the port and the encryption setting.",
  );
  expect(syncErrorText(i18n, SYNC_FAILURE_TEXT.unsafe_login)).toContain("Turn on IMAP");
  expect(syncErrorText(i18n, SYNC_FAILURE_TEXT.dns)).toContain("Check the server name");
  expect(syncErrorText(i18n, SYNC_FAILURE_TEXT.refused)).toContain("Check the port");
  expect(syncErrorText(i18n, SYNC_FAILURE_TEXT.no_response)).toContain("didn't respond");
});
