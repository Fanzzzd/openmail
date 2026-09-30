import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ThreadQuery, ThreadSummary } from "../../../shared/api";
import { refreshPages } from "./list-pages";

const row = (i: number): ThreadSummary => ({
  id: `m${i}`,
  accountId: "a",
  threadId: `t${i}`,
  subject: "",
  from: { name: "", address: "" },
  date: 1000 - i,
  snippet: "",
  labels: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  threadCount: 1,
  participants: [],
});
describe("list invalidation", () => {
  it("reloads 300 loaded rows once and keeps row 300 selectable", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i));
    const requests: ThreadQuery[] = [];
    const next = await Effect.runPromise(
      refreshPages(
        { mailbox: "inbox" },
        { threads: rows, pages: 3, requested: 3, done: false },
        (q) =>
          Effect.sync(() => {
            requests.push(q);
            return rows.slice(0, q.limit);
          }),
      ),
    );
    expect(requests).toEqual([{ mailbox: "inbox", limit: 300 }]);
    expect(next.threads.find((r) => r.id === "m299")).toEqual(rows[299]);
    expect(next.pages).toBe(3);
    expect(next.requested).toBe(3);
  });
  it("removes deleted rows without collapsing to the first page", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => row(i));
    const next = await Effect.runPromise(
      refreshPages({}, { threads: rows, pages: 3, requested: 3, done: false }, () =>
        Effect.succeed(rows.filter((r) => r.id !== "m100")),
      ),
    );
    expect(next.threads).toHaveLength(299);
    expect(next.threads.at(-1)?.id).toBe("m299");
  });
});
