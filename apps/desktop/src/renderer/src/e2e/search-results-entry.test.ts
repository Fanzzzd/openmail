// The keyboard handoff from the search field to its results, against a thread list that answers
// late. The rule these tests hold is at the top of features/search/results-entry.ts.
import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { eventually, flow, incoming, key, row, wait } from "./harness";

const reader = () => document.querySelector('[data-mail-pane="reader"]')?.textContent ?? "";
const selectedRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-id][aria-selected="true"]')].map(
    (element) => element.dataset.id,
  );

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

const messages = () => [
  incoming("one", { subject: "Quarterly report", date: Date.now() - 1000 }),
  incoming("two", { subject: "Lunch on Friday", date: Date.now() - 2000 }),
  incoming("three", { subject: "Lunch menu", date: Date.now() - 3000 }),
];

/** Opens the app with every unread message marked read at once when it is opened. */
async function start() {
  current = await flow({ messages: messages(), prefs: { markReadDelay: 0 } });
  const h = current;
  await eventually(() => expect(row(h.id("three"))).toBeTruthy());
  const field = screen.getByLabelText<HTMLInputElement>("Search mail");
  field.focus();
  /** The messages marked read so far, queued or pushed. */
  const markedRead = async () =>
    [
      ...new Set(
        [...(await h.run(h.store.listPendingOps)), ...h.server.pushed]
          .filter(({ op }) => op.kind === "read")
          .map(({ providerId }) => providerId),
      ),
    ].toSorted();
  return { h, field, markedRead };
}

// Down entered the list on screen, which still showed Inbox while the new query loaded: Inbox's
// first row opened and was marked read, then the empty result left focus on the page body.
it("Down right after typing a search with no results waits for it and stays in the field", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "zzzz" } });
  key("ArrowDown", {}, field);
  await wait(100);
  // The old rows are still on screen and must not be touched.
  expect(row(h.id("one"))).toBeTruthy();
  expect(selectedRows()).toEqual([]);
  expect(document.activeElement).toBe(field);
  await release();
  await screen.findByText("No matching messages");
  await wait(100);
  expect(document.activeElement).toBe(field);
  expect(selectedRows()).toEqual([]);
  expect(reader()).not.toContain("Quarterly report");
  expect(await markedRead()).toEqual([]);
});

it("Down right after typing enters the new results once they arrive", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  key("ArrowDown", {}, field);
  await wait(100);
  expect(selectedRows()).toEqual([]);
  expect(await markedRead()).toEqual([]);
  expect(document.activeElement).toBe(field);
  await release();
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
  expect(selectedRows()).toEqual([h.id("two")]);
  await eventually(() => expect(reader()).toContain("Lunch on Friday"));
  // Only the result that opened is marked read; Inbox's first row never opened.
  await eventually(async () => expect(await markedRead()).toEqual(["two"]));
});

it("Enter twice while the search loads enters its results once they arrive", async () => {
  const { h, field } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  key("Enter", {}, field);
  key("Enter", {}, field);
  await wait(100);
  expect(selectedRows()).toEqual([]);
  expect(document.activeElement).toBe(field);
  await release();
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
  expect(selectedRows()).toEqual([h.id("two")]);
});

// `from:` waits while typed, so the list still showed Inbox; Down selected Inbox's first row and
// the selection then jumped to a row of the results, or focus sat on a list with nothing selected.
it("an operator with Down selects the first row of its own results", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "subject:menu" } });
  expect(field.getAttribute("aria-expanded")).toBe("false");
  key("ArrowDown", {}, field);
  await wait(100);
  expect(selectedRows()).toEqual([]);
  expect(document.activeElement).toBe(field);
  expect(await markedRead()).toEqual([]);
  await release();
  await eventually(() => expect(document.activeElement).toBe(row(h.id("three"))));
  expect(selectedRows()).toEqual([h.id("three")]);
  expect(() => row(h.id("one"))).toThrow();
});

it("Down keeps an already selected result selected and focuses it", async () => {
  const { h, field, markedRead } = await start();
  fireEvent.click(row(h.id("three")));
  await eventually(() => expect(reader()).toContain("Lunch menu"));
  await eventually(async () => expect(await markedRead()).toEqual(["three"]));
  field.focus();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  key("ArrowDown", {}, field);
  await wait(100);
  expect(document.activeElement).toBe(field);
  await release();
  await eventually(() => expect(document.activeElement).toBe(row(h.id("three"))));
  expect(selectedRows()).toEqual([h.id("three")]);
  expect(reader()).toContain("Lunch menu");
  // The first result was never opened.
  await wait(100);
  expect(await markedRead()).toEqual(["three"]);
});

it("editing the search after Down drops the request; the next Down enters the new results", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  key("ArrowDown", {}, field);
  fireEvent.change(field, { target: { value: "quarterly" } });
  await release();
  await eventually(() => expect(() => row(h.id("two"))).toThrow());
  await wait(100);
  expect(document.activeElement).toBe(field);
  expect(selectedRows()).toEqual([]);
  expect(await markedRead()).toEqual([]);
  key("ArrowDown", {}, field);
  await eventually(() => expect(document.activeElement).toBe(row(h.id("one"))));
  expect(selectedRows()).toEqual([h.id("one")]);
});

it("Down from a field holding a chip enters that search's results", async () => {
  const { h, field } = await start();
  const release = await h.holdLists();
  fireEvent.input(field, { target: { value: "subject:lunch " }, inputType: "insertText" });
  await eventually(() =>
    expect(screen.getByRole("button", { name: "Modify subject:lunch" })).toBeTruthy(),
  );
  expect(field.getAttribute("aria-expanded")).toBe("false");
  key("ArrowDown", {}, field);
  await wait(100);
  expect(selectedRows()).toEqual([]);
  await release();
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
  expect(selectedRows()).toEqual([h.id("two")]);
});

it("Escape after Down while the search loads returns to the mailbox without opening anything", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "quarterly" } });
  key("ArrowDown", {}, field);
  key("Escape", {}, field);
  await release();
  await eventually(() =>
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Inbox" })),
  );
  await wait(100);
  expect(selectedRows()).toEqual([]);
  expect(reader()).not.toContain("Quarterly report");
  expect(await markedRead()).toEqual([]);
});

// Focus was checked only when the list answered, so leaving the field and coming back while the
// search loaded kept the request: the first result opened and was marked read.
it("leaving the search field after Down drops the request, even when focus comes back", async () => {
  const { h, field, markedRead } = await start();
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  key("ArrowDown", {}, field);
  field.blur();
  field.focus();
  await release();
  await eventually(() => expect(() => row(h.id("one"))).toThrow());
  await wait(100);
  expect(document.activeElement).toBe(field);
  expect(selectedRows()).toEqual([]);
  expect(reader()).not.toContain("Lunch on Friday");
  expect(await markedRead()).toEqual([]);
});

// A click on a row of the previous list while a new search loaded did nothing but focus the row,
// and once the results replaced it focus fell to the page body.
it("the previous list's rows are dimmed and inert while a search loads", async () => {
  const { h, field, markedRead } = await start();
  const list = () => screen.getByRole("listbox");
  const release = await h.holdLists();
  fireEvent.change(field, { target: { value: "lunch" } });
  await eventually(() => expect(list().getAttribute("aria-busy")).toBe("true"));
  // jsdom ignores inert; Chromium sends a click on these rows to the list behind them.
  expect(row(h.id("one")).closest("[inert]")).not.toBeNull();
  expect(row(h.id("one")).closest("[data-stale]")?.className).toContain("opacity-50");
  await release();
  await eventually(() => expect(() => row(h.id("one"))).toThrow());
  expect(list().getAttribute("aria-busy")).toBe("false");
  expect(row(h.id("two")).closest("[inert]")).toBeNull();
  expect(row(h.id("two")).closest("[data-stale]")).toBeNull();
  expect(document.activeElement).toBe(field);
  expect(selectedRows()).toEqual([]);
  expect(await markedRead()).toEqual([]);
});
