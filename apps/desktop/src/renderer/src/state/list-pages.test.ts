import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ThreadQuery, ThreadSummary } from "../../../shared/api";
import { pageAfterRemoval, refreshPages, searchExtent } from "./list-pages";

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

it("ranked search grows one window without paging from a relevance-sorted date", async () => {
  const requests: ThreadQuery[] = [];
  const ranked = [row(399), ...Array.from({ length: 399 }, (_, index) => row(index))];
  const loaded = await Effect.runPromise(
    searchExtent({ search: "invoice" }, 2, (query) => {
      requests.push(query);
      return Effect.succeed(ranked);
    }),
  );
  expect(requests).toEqual([{ search: "invoice", limit: 400 }]);
  expect(loaded.threads).toEqual(ranked);
  expect(loaded.done).toBe(false);
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
  it("reads only through the page after the reachable rows, however many are loaded", async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => row(i));
    const refresh = (reach: number | undefined, query: ThreadQuery = { mailbox: "inbox" }) => {
      const requests: ThreadQuery[] = [];
      return Effect.runPromise(
        refreshPages(
          query,
          { threads: rows, pages: 20, requested: 20, done: false },
          (q) =>
            Effect.sync(() => {
              requests.push(q);
              return rows.slice(0, q.limit);
            }),
          reach,
        ),
      ).then((next) => ({ next, limits: requests.map((q) => q.limit) }));
    };
    // At the top: two pages, and the list pages in again on scroll.
    const top = await refresh(20);
    expect(top.limits).toEqual([200]);
    expect(top.next.threads).toHaveLength(200);
    expect(top.next.pages).toBe(2);
    expect(top.next.requested).toBe(20);
    expect(top.next.done).toBe(false);
    // Scrolled to row 1,450, or a selection that far down: through the page after it.
    expect((await refresh(1450)).limits).toEqual([1600]);
    // Unknown reach and ranked search keep the loaded extent.
    expect((await refresh(undefined)).limits).toEqual([2000]);
    expect((await refresh(20, { search: "invoice" })).limits).toEqual([2000]);
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

it("deleting the loaded tail queries and selects the first row beyond the deleted cursor", async () => {
  const rows = Array.from({ length: 200 }, (_, index) => row(index));
  const boundary = rows[99];
  if (!boundary) throw new Error("Missing tail");
  const afterDelete = rows.filter((item) => item.id !== boundary.id);
  const read = (query: ThreadQuery) =>
    Effect.succeed(
      afterDelete.filter((item) => item.date < (query.before ?? Infinity)).slice(0, query.limit),
    );
  const page = await Effect.runPromise(
    pageAfterRemoval({ mailbox: "inbox", accountIds: ["a"] }, boundary, read),
  );
  expect(page[0]?.id).toBe("m100");
  expect(page[0]?.id).not.toBe("m98");
  expect(page).toHaveLength(100);
});
