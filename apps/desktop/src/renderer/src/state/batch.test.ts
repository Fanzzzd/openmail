import { describe, expect, it } from "vitest";
import type { ThreadSummary } from "../../../shared/api";
import { DEFAULT_LIST_FILTERS } from "@openmail/core/schema";
import { leavesList } from "./batch";
import {
  moveCursor,
  moveSelection,
  reconcileSelection,
  selectRow,
  singleSelection,
  toggleFocused,
} from "../lib/selection";

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
  it("list filters retain OR matches and intersect In Inbox after an action", () => {
    const filters = { ...DEFAULT_LIST_FILTERS, enabled: true, unread: true, starred: true };
    expect(
      leavesList(row, { kind: "read", value: true }, "gmail", { listFilters: filters }, []),
    ).toBe(false);
    expect(
      leavesList(
        { ...row, labels: ["INBOX", "UNREAD"] },
        { kind: "read", value: true },
        "gmail",
        { listFilters: filters },
        [],
      ),
    ).toBe(true);
    expect(
      leavesList(
        row,
        { kind: "important", value: false },
        "gmail",
        { listFilters: { ...DEFAULT_LIST_FILTERS, enabled: true, important: true } },
        [],
      ),
    ).toBe(true);
    expect(
      leavesList(
        row,
        { kind: "archive" },
        "gmail",
        { mailbox: "all", label: "custom", listFilters: { ...filters, inInbox: true } },
        [],
      ),
    ).toBe(true);
    expect(
      leavesList(
        row,
        { kind: "archive" },
        "gmail",
        {
          mailbox: "all",
          label: "custom",
          listFilters: { ...filters, inInbox: true, enabled: false },
        },
        [],
      ),
    ).toBe(false);
  });
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

  it("keeps an X-checked thread in a Shift range after a reply changes its ID", () => {
    const a = row;
    const [b, c, d] = ["t2", "t3", "t4"].map((threadId, index) => ({
      ...row,
      id: `a/${threadId}`,
      threadId,
      date: 9 - index,
    }));
    if (!b || !c || !d) throw new Error("fixture");
    const before = [a, b, c, d];
    // X on A, J to B, then Shift+J: A stays checked, B and C join.
    let selection = toggleFocused(singleSelection(a.id));
    selection = moveCursor(
      selection,
      before.map((thread) => thread.id),
      1,
    );
    selection = moveSelection(
      selection,
      before.map((thread) => thread.id),
      1,
      true,
    );
    expect(selection.ids).toEqual(new Set([a.id, b.id, c.id]));

    // A reply makes a/m2 thread A's representative.
    const reply = { ...a, id: "a/m2", date: 20 };
    const after = [reply, b, c, d];
    selection = reconcileSelection(selection, new Map(before.map((t) => [t.id, t])), after, false);
    expect([...(selection.kept ?? [])]).toEqual([reply.id]);

    // Another Shift+J grows the range and still keeps thread A.
    selection = moveSelection(
      selection,
      after.map((thread) => thread.id),
      1,
      true,
    );
    expect(selection.ids).toEqual(new Set([reply.id, b.id, c.id, d.id]));
  });
});
