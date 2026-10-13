import { setupI18n } from "@lingui/core";
import { expect, it } from "vitest";
import { auditActionName } from "./audit-actions";

it("names logged actions and never shows an unknown action's raw id", () => {
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  expect(auditActionName(i18n, "connect")).toBe("Connect account");
  expect(auditActionName(i18n, "removeAccount")).toBe("Remove account");
  expect(auditActionName(i18n, "filter_restore_discard")).toBe("Other action");
  expect(auditActionName(i18n, "toString")).toBe("Other action");
});
