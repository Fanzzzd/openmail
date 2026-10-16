import { assert, describe, it } from "@effect/vitest";
import { type SearchCursor, type SearchRest, searchRest } from "./search-page.js";

type Row = { id: string; date: number };
const row = (id: string, date: number): Row => ({ id, date });

/** Pages through `results(page)` with `limit` rows a page; `results` can change between pages. */
function pages(results: (page: number) => Row[], limit: number) {
  const shown: string[] = [];
  let cursor: SearchCursor | null = {};
  for (let page = 0; cursor && page < 20; page++) {
    const rest: SearchRest<Row> = searchRest(results(page), cursor);
    const rows = rest.rows.slice(0, limit);
    shown.push(...rows.map((r) => r.id));
    cursor = rest.next(rows.length);
  }
  return shown;
}

describe("searchRest", () => {
  const all = Array.from({ length: 10 }, (_, i) => row(`m${9 - i}`, 9 - i));

  it("continues a date-ordered result after the last row shown when a row disappears", () => {
    // m8 was on the first page and disappears before the second, as after a sync.
    const shown = pages((page) => (page === 0 ? all : all.filter((r) => r.id !== "m8")), 3);
    assert.deepStrictEqual(
      shown,
      all.map((r) => r.id),
    );
    // A row from a later page that disappears is not shown, and nothing repeats.
    const later = pages((page) => (page === 0 ? all : all.filter((r) => r.id !== "m4")), 3);
    assert.deepStrictEqual(
      later,
      all.map((r) => r.id).filter((id) => id !== "m4"),
    );
  });

  it("keeps rows that share a date apart by id, in SQLite text order", () => {
    const tied = [row("b", 5), row("a", 5), row("Z", 5), row("c", 4)];
    assert.deepStrictEqual(
      pages(() => tied, 1),
      ["b", "a", "Z", "c"],
    );
  });

  it("continues a tied date by id when the row shown last disappears between pages", () => {
    const tied = [row("b", 5), row("a", 5), row("Z", 5), row("c", 4)];
    // b ends the first page and is gone for the second: a position would skip a.
    assert.deepStrictEqual(
      pages((page) => (page === 0 ? tied : tied.filter((r) => r.id !== "b")), 1),
      ["b", "a", "Z", "c"],
    );
    // A tied row that has not been shown yet disappears: the others keep their order.
    assert.deepStrictEqual(
      pages((page) => (page === 0 ? tied : tied.filter((r) => r.id !== "a")), 1),
      ["b", "Z", "c"],
    );
  });

  it("pages a relevance-ordered result by position", () => {
    const ranked = [row("x", 1), row("y", 3), row("z", 2)];
    const first = searchRest(ranked, {});
    assert.deepStrictEqual(first.next(1), { offset: 1 });
    assert.deepStrictEqual(
      searchRest(ranked, { offset: 1 }).rows.map((r) => r.id),
      ["y", "z"],
    );
    assert.deepStrictEqual(
      pages(() => ranked, 2),
      ["x", "y", "z"],
    );
  });

  it("returns no cursor after the last page", () => {
    assert.isNull(searchRest(all, {}).next(10));
    assert.deepStrictEqual(searchRest(all, {}).next(3), { date: 7, id: "m7" });
  });
});
