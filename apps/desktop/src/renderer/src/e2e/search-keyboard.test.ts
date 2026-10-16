import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { eventually, flow, incoming, key, row } from "./harness";

const reader = () => document.querySelector('[data-mail-pane="reader"]')?.textContent ?? "";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

for (const stroke of ["ArrowDown", "Enter"])
  it(`${stroke} after a search runs moves focus to the first result`, async () => {
    current = await flow({
      messages: [
        incoming("one", { subject: "Quarterly report" }),
        incoming("two", { subject: "Lunch on Friday" }),
      ],
    });
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    const field = screen.getByLabelText("Search mail");
    field.focus();
    fireEvent.change(field, { target: { value: "Lunch" } });
    key("Enter", {}, field);
    await eventually(() => expect(row(h.id("two"))).toBeTruthy());
    await eventually(() => expect(() => row(h.id("one"))).toThrow());
    expect(document.activeElement).toBe(field);
    key(stroke, {}, field);
    expect(document.activeElement).toBe(row(h.id("two")));
  });

it("Down before the search runs stays in the field", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByLabelText("Search mail");
  field.focus();
  fireEvent.change(field, { target: { value: "Lunch" } });
  key("ArrowDown", {}, field);
  expect(document.activeElement).toBe(field);
});

it("a space typed after a word stays in the field", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByLabelText<HTMLInputElement>("Search mail");
  field.focus();
  for (const typed of ["board", "board ", "board new", "board new ", "board new newer:yesterday "])
    fireEvent.change(field, { target: { value: typed } });
  await eventually(() => expect(field.value).toBe("board new "));
  expect(screen.getByRole("button", { name: "Modify newer:yesterday" })).toBeTruthy();
});

for (const typed of ["board notes is:unread ", "board meeting from:elena "])
  it(`a word typed after the chip in "${typed}" starts a new word`, async () => {
    current = await flow();
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    const field = screen.getByLabelText<HTMLInputElement>("Search mail");
    field.focus();
    fireEvent.change(field, { target: { value: typed } });
    const words = typed.split(" ").slice(0, 2).join(" ");
    await eventually(() => expect(field.value).toBe(`${words} `));
    for (const next of ["n", "ne", "nex", "next"])
      fireEvent.change(field, { target: { value: `${words} ${next}` } });
    await eventually(() => expect(field.value).toBe(`${words} next`));
    expect(
      screen.getByRole("button", { name: `Modify ${typed.trim().split(" ").at(-1)}` }),
    ).toBeTruthy();
  });

it("clearing a search reopens the mailbox's conversation at its scroll position", async () => {
  // jsdom lays nothing out; a 600 px list shows rows 5 to 11 at a 500 px scroll.
  const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  try {
    current = await flow({
      messages: Array.from({ length: 30 }, (_, index) =>
        incoming(`m${index}`, {
          subject: index === 6 ? "Board minutes" : `Note ${index}`,
          date: Date.now() - (index + 1) * 60_000,
        }),
      ),
    });
    const h = current;
    await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
    const list = screen.getByRole("listbox", { name: "Inbox" });
    list.scrollTop = 500;
    fireEvent.scroll(list);
    await eventually(() => expect(row(h.id("m6"))).toBeTruthy());
    fireEvent.click(row(h.id("m6")));
    await eventually(() => expect(reader()).toContain("Board minutes"));

    const field = screen.getByLabelText("Search mail");
    field.focus();
    fireEvent.change(field, { target: { value: "Board" } });
    key("Enter", {}, field);
    await eventually(() => expect(() => row(h.id("m0"))).toThrow());
    // The open conversation is one of the results, so it stays open.
    expect(row(h.id("m6")).getAttribute("aria-selected")).toBe("true");
    expect(reader()).toContain("Board minutes");

    key("Escape", {}, field);
    await eventually(() => expect(row(h.id("m0"))).toBeTruthy());
    await eventually(() => expect(document.activeElement).toBe(row(h.id("m6"))));
    expect(screen.getByRole("listbox", { name: "Inbox" }).scrollTop).toBe(500);
    expect(row(h.id("m6")).getAttribute("aria-selected")).toBe("true");
  } finally {
    height.mockRestore();
  }
});

it("clearing a search reopens the conversation the results did not include", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("two")));
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  const field = screen.getByLabelText("Search mail");
  field.focus();
  fireEvent.change(field, { target: { value: '"Flow one"' } });
  key("Enter", {}, field);
  await eventually(() => expect(() => row(h.id("two"))).toThrow());
  key("Escape", {}, field);
  await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
  await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
});

const clearings = [
  // The empty list's button leaves the field, so focus goes back to the restored row.
  { clear: "the empty list's Clear search", query: "nothing-matches", focus: "row" },
  // The field's own button and an emptied field keep the person in the field.
  { clear: "the field's Clear search", query: '"Flow one"', focus: "field" },
  { clear: "an emptied field", query: '"Flow one"', focus: "field" },
] as const;

// Escape moves focus to the row by itself, so the tests above pass without the focus return.
// These clear the search without Escape.
for (const { clear, query, focus } of clearings)
  it(`clearing a search with ${clear} restores the selection and focuses the ${focus}`, async () => {
    current = await flow();
    const h = current;
    await eventually(() => expect(row(h.id("one"))).toBeTruthy());
    fireEvent.click(row(h.id("two")));
    await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
    const field = screen.getByLabelText<HTMLInputElement>("Search mail");
    field.focus();
    fireEvent.change(field, { target: { value: query } });
    key("Enter", {}, field);
    await eventually(() => expect(() => row(h.id("two"))).toThrow());
    if (clear === "an emptied field") fireEvent.change(field, { target: { value: "" } });
    else {
      const inList = clear === "the empty list's Clear search";
      if (inList) await screen.findByText("No matching messages");
      // The field's button shows an icon; the empty list's shows the words.
      const button = screen
        .getAllByRole("button", { name: "Clear search" })
        .find((candidate) => (candidate.textContent === "Clear search") === inList);
      if (!button) throw new Error(`Missing ${clear}`);
      // A click focuses a button in Chromium; fireEvent.click does not.
      button.focus();
      fireEvent.click(button);
    }
    await eventually(() => expect(row(h.id("two")).getAttribute("aria-selected")).toBe("true"));
    if (focus === "row")
      await eventually(() => expect(document.activeElement).toBe(row(h.id("two"))));
    else expect(document.activeElement).toBe(field);
  });

it("clearing a search with nothing selected puts focus on the list", async () => {
  current = await flow();
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  const field = screen.getByLabelText<HTMLInputElement>("Search mail");
  field.focus();
  fireEvent.change(field, { target: { value: "nothing-matches" } });
  key("Enter", {}, field);
  await screen.findByText("No matching messages");
  const button = screen
    .getAllByRole("button", { name: "Clear search" })
    .find((candidate) => candidate.textContent === "Clear search");
  if (!button) throw new Error("Missing the empty list's Clear search");
  button.focus();
  fireEvent.click(button);
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  await eventually(() =>
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "Inbox" })),
  );
});
