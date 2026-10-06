import { expect, it } from "vitest";
import { permanentDeleteFolder, supportsInInboxFilter } from "./folder-actions";
import type { View } from "./view";

it("permanent deletion is offered only in Trash or Spam folder lists", () => {
  for (const mailbox of [
    "inbox",
    "sent",
    "starred",
    "important",
    "drafts",
    "all",
    "snoozed",
  ] as const)
    expect(permanentDeleteFolder({ space: "all", mailbox }, null)).toBe(null);
  for (const mailbox of ["trash", "spam"] as const) {
    const view = { space: "all", mailbox };
    expect(permanentDeleteFolder(view, null)).toBe(mailbox);
    expect(permanentDeleteFolder(view, { search: "subject" })).toBe(null);
    expect(permanentDeleteFolder(view, { search: "subject", searchScope: "folder" })).toBe(mailbox);
  }
});
it("In Inbox is available for Gmail labels and categories, excluding exclusive provider folders", () => {
  const view: View = { space: "all", mailbox: "all", label: { accountId: "a", id: "custom" } };
  expect(supportsInInboxFilter(view, [{ id: "a", provider: "gmail" }])).toBe(true);
  expect(supportsInInboxFilter(view, [{ id: "a", provider: "outlook" }])).toBe(false);
  expect(supportsInInboxFilter(view, [{ id: "a", provider: "imap" }])).toBe(false);
  expect(
    supportsInInboxFilter({ space: "all", mailbox: "inbox", label: { id: "CATEGORY_SOCIAL" } }, []),
  ).toBe(true);
  expect(supportsInInboxFilter({ space: "all", mailbox: "inbox" }, [])).toBe(false);
});

it("Outlook Inbox labels use Focused/Other while Gmail keeps its five categories", async () => {
  const { inboxCategoryNames } = await import("./view");
  const outlook = inboxCategoryNames(true);
  expect(Object.keys(outlook)).toEqual(["CATEGORY_PERSONAL", "CATEGORY_OTHER"]);
  expect(outlook.CATEGORY_PERSONAL?.message).toBe("Focused");
  expect(outlook.CATEGORY_OTHER?.message).toBe("Other");
  expect(inboxCategoryNames(false).CATEGORY_PERSONAL?.message).toBe("Primary");
});
