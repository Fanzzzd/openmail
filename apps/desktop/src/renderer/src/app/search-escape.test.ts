// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { escapeClearsSearch } from "./search-escape";

afterEach(() => {
  document.body.innerHTML = "";
});

function layout() {
  document.body.innerHTML = `
    <input aria-label="Search mail" aria-expanded="false">
    <div data-mail-pane="list"><div role="listbox"><button data-id="a">Row</button></div></div>
    <div data-mail-pane="reader"><div data-reader-text tabindex="-1">Message</div></div>
    <div role="menu"><button>Item</button></div>
    <div role="dialog"><button>OK</button></div>`;
  const get = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(selector);
    return element;
  };
  const field = get("input");
  if (!(field instanceof HTMLInputElement)) throw new Error("field");
  return {
    field,
    row: get("[data-id]"),
    reader: get("[data-reader-text]"),
    menu: get('[role="menu"] button'),
    dialog: get('[role="dialog"] button'),
  };
}

it("Escape in the search field clears it unless its suggestions are open", () => {
  const { field } = layout();
  expect(escapeClearsSearch({ target: field, field, readerOpen: true })).toBe(true);
  field.setAttribute("aria-expanded", "true");
  expect(escapeClearsSearch({ target: field, field, readerOpen: false })).toBe(false);
});

it("Escape in the list clears the search only while no conversation is open", () => {
  const { field, row } = layout();
  expect(escapeClearsSearch({ target: row, field, readerOpen: false })).toBe(true);
  expect(escapeClearsSearch({ target: row, field, readerOpen: true })).toBe(false);
});

it("Escape in a message, menu, dialog or the page leaves the search alone", () => {
  const { field, reader, menu, dialog } = layout();
  for (const target of [reader, menu, dialog, document.body, null])
    expect(escapeClearsSearch({ target, field, readerOpen: false })).toBe(false);
});
