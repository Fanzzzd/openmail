import { ThreadSummary } from "@openmail/core/portable";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { appendPage, pageQuery } from "./paging";

const row = (id: string) =>
  Schema.decodeUnknownSync(ThreadSummary)({
    id,
    threadId: id,
    accountId: "gmail:me",
    date: 123,
    subject: "test",
    snippet: "",
    labels: [],
    from: { name: "", address: "sender@example.test" },
    isUnread: false,
    isStarred: false,
    hasAttachments: false,
    threadCount: 1,
    participants: [],
  });
it("passes both cursor fields for tied dates and deduplicates overlapping pages", () => {
  expect(pageQuery("gmail:me", "INBOX", row("last"))).toMatchObject({
    before: 123,
    beforeId: "last",
    limit: 30,
  });
  expect(pageQuery("gmail:me", "INBOX")).not.toHaveProperty("beforeId");
  expect(appendPage([row("a"), row("b")], [row("b"), row("c")]).map((item) => item.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
});
it("routes local drafts through the shared drafts mailbox projection", () => {
  expect(pageQuery("gmail:me", "drafts")).toEqual({
    accountIds: ["gmail:me"],
    mailbox: "drafts",
    limit: 30,
  });
});
