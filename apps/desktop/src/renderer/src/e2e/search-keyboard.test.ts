import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { eventually, flow, incoming, key, row } from "./harness";

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
