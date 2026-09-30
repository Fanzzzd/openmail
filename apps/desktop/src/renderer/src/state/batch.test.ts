import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../../shared/api";
import { leavesList } from "./batch";
import { reconcileSelection, selectRow, singleSelection } from "./selection";

const row: ThreadSummary = {
  id: "a/m1",
  accountId: "a",
  threadId: "t1",
  labels: ["INBOX", "custom", "UNREAD", "STARRED", "IMPORTANT"],
  subject: "Subject",
  from: { name: "", address: "a@example.com" },
  date: 10,
  snippet: "",
  isUnread: true,
  isStarred: true,
  hasAttachments: false,
  threadCount: 1,
  participants: [],
};
describe("batch selection after actions", () => {
  it("archive keeps Gmail label, All Mail and search selections but leaves Inbox", () => {
    expect(leavesList(row, { kind: "archive" }, "gmail", { mailbox: "inbox" }, [])).toBe(true);
    expect(leavesList(row, { kind: "archive" }, "gmail", { mailbox: "all" }, [])).toBe(false);
    expect(
      leavesList(row, { kind: "archive" }, "gmail", { mailbox: "all", label: "custom" }, []),
    ).toBe(false);
    expect(
      leavesList(row, { kind: "archive" }, "gmail", { mailbox: "inbox", search: "Subject" }, []),
    ).toBe(false);
    expect(
      leavesList(
        row,
        { kind: "archive" },
        "gmail",
        { mailbox: "inbox", search: "Subject", searchScope: "folder" },
        [],
      ),
    ).toBe(true);
  });
  it("folder moves leave only views that no longer contain the message", () => {
    for (const provider of ["outlook", "imap"] as const) {
      expect(
        leavesList(
          row,
          { kind: "label", labelId: "target", value: true },
          provider,
          { mailbox: "all", label: "custom" },
          [],
        ),
      ).toBe(true);
      expect(
        leavesList(
          row,
          { kind: "label", labelId: "target", value: true },
          provider,
          { mailbox: "all" },
          [],
        ),
      ).toBe(false);
    }
    expect(leavesList(row, { kind: "trash" }, "gmail", { mailbox: "all" }, [])).toBe(true);
    expect(
      leavesList(row, { kind: "star", value: false }, "gmail", { mailbox: "starred" }, []),
    ).toBe(true);
    expect(leavesList(row, { kind: "read", value: true }, "gmail", { unreadOnly: true }, [])).toBe(
      true,
    );
    expect(leavesList(row, { kind: "star", value: true }, "gmail", { unreadOnly: true }, [])).toBe(
      false,
    );
  });
  it("search operators update selection using flags and account-specific label names", () => {
    expect(
      leavesList(row, { kind: "read", value: true }, "gmail", { search: "is:unread" }, []),
    ).toBe(true);
    expect(
      leavesList(row, { kind: "star", value: false }, "gmail", { search: "is:starred" }, []),
    ).toBe(true);
    const labels = [{ accountId: "a", id: "custom", name: "Work", color: null }];
    expect(
      leavesList(
        row,
        { kind: "label", labelId: "custom", value: false },
        "gmail",
        { search: "label:Work" },
        labels,
      ),
    ).toBe(true);
  });
  it("a new representative keeps the conversation selected and retains off-window IDs", () => {
    const other = { ...row, id: "b/m1", accountId: "b" };
    const previous = new Map([
      [row.id, row],
      [other.id, other],
    ]);
    const selection = selectRow(singleSelection(row.id), [row.id, other.id], other.id, {
      toggle: true,
    });
    const newer = { ...row, id: "a/m2", date: 20 };
    const reconciled = reconcileSelection(selection, previous, [newer], false);
    expect([...reconciled.ids]).toEqual([newer.id, other.id]);
    expect(reconciled.focus).toBe(other.id);
    expect(reconcileSelection(selection, previous, [newer], true)).toBe(selection);
    expect(reconcileSelection(singleSelection(row.id), previous, [newer], false)).toEqual(
      singleSelection(newer.id),
    );
  });
});
