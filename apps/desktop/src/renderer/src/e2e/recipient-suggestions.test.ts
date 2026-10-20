import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { screen } from "@testing-library/react/pure";
import { clickButton, eventually, flow, row, wait } from "./harness";

let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  hidden.clear();
});

const work = { name: "Jordan Lee", address: "jordan.lee@work.example" };
const home = { name: "Jordan Lee", address: "jordan@home.example" };
const chip = (text: string) => screen.queryByRole("button", { name: `Remove ${text}` });
const to = () => screen.getByRole("combobox", { name: "To" });
/** Addresses the user stopped suggesting, as SetContactHidden left them. */
const hidden = new Set<string>();

/**
 * Opens a composer whose contact suggestions arrive 50 ms after each query. Typing at 120 ms a
 * key, the list opens for one query, closes on the next key and opens again once that query's
 * suggestions arrive, after the last keystroke.
 */
async function composer() {
  current = await flow({
    handlers: {
      SuggestContacts: ({ query }) =>
        Effect.succeed(
          query.toLowerCase().startsWith("j")
            ? [work, home].filter((a) => !hidden.has(a.address))
            : [],
        ).pipe(Effect.delay("50 millis")),
      SetContactHidden: ({ address, hidden: hide }) =>
        Effect.sync(() => {
          if (hide) hidden.add(address);
          else hidden.delete(address);
        }),
    },
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  clickButton("New message");
  await eventually(() => expect(to()).toBeTruthy());
  const user = userEvent.setup({ delay: 120 });
  await user.click(to());
  return user;
}

async function typeAndWait(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(to(), text);
  await eventually(() => expect(screen.getAllByRole("option")).toHaveLength(2));
}

// Base UI highlighted the first item only on a keystroke that found items already listed, so
// suggestions that came after the last key left nothing highlighted and Enter or Tab made an
// invalid "jor" chip.
for (const stroke of ["{Enter}", "{Tab}"])
  it(`${stroke} picks the first suggestion that arrived after the last key`, async () => {
    const user = await composer();
    await typeAndWait(user, "jor");
    await eventually(() => expect(to().getAttribute("aria-activedescendant")).toBeTruthy());
    await user.keyboard(stroke);
    await eventually(() => expect(chip(`Jordan Lee <${work.address}>`)).toBeTruthy());
    expect(chip("jor")).toBeNull();
    expect(document.activeElement).toBe(to());
  });

it("Down and Up move the highlight through suggestions that arrived late", async () => {
  const user = await composer();
  await typeAndWait(user, "jor");
  await user.keyboard("{ArrowDown}{ArrowUp}{ArrowDown}{Enter}");
  await eventually(() => expect(chip(`Jordan Lee <${home.address}>`)).toBeTruthy());
  expect(chip(`Jordan Lee <${work.address}>`)).toBeNull();
});

// A complete typed address showed the first suggestion highlighted, and announced it through
// aria-activedescendant, while Enter and Tab committed the typed address instead.
for (const stroke of ["{Enter}", "{Tab}"])
  it(`${stroke} keeps a complete typed address, which shows no highlighted suggestion`, async () => {
    const user = await composer();
    await typeAndWait(user, "jo@example.org");
    await wait(100);
    expect(to().getAttribute("aria-activedescendant")).toBeNull();
    expect(document.querySelector("[role=option][data-highlighted]")).toBeNull();
    await user.keyboard(stroke);
    await eventually(() => expect(chip("jo@example.org")).toBeTruthy());
    expect(chip(`Jordan Lee <${work.address}>`)).toBeNull();
  });

it("Down from a complete typed address highlights the first suggestion, and Enter picks it", async () => {
  const user = await composer();
  await typeAndWait(user, "jo@example.org");
  await user.keyboard("{ArrowDown}");
  await eventually(() => {
    const active = to().getAttribute("aria-activedescendant");
    expect(active && document.getElementById(active)?.textContent).toContain(work.address);
  });
  await user.keyboard("{Enter}");
  await eventually(() => expect(chip(`Jordan Lee <${work.address}>`)).toBeTruthy());
  expect(chip("jo@example.org")).toBeNull();
});

it("Enter and Tab turn an address with no suggestion into a chip", async () => {
  const user = await composer();
  await user.type(to(), "carol@example.com");
  await wait(400);
  await user.keyboard("{Enter}");
  await eventually(() => expect(chip("carol@example.com")).toBeTruthy());
  expect(document.activeElement).toBe(to());
  await user.type(to(), "dave@example.com");
  await wait(400);
  await user.keyboard("{Tab}");
  await eventually(() => expect(chip("dave@example.com")).toBeTruthy());
  expect(document.activeElement).not.toBe(to());
});

it("a comma still turns the typed text into a chip with suggestions showing", async () => {
  const user = await composer();
  await typeAndWait(user, "jor");
  await user.type(to(), ",");
  await eventually(() => expect(chip("jor")).toBeTruthy());
  expect(chip(`Jordan Lee <${work.address}>`)).toBeNull();
});

// The Cc/Bcc button unmounts itself, so focus fell to the page body.
it("the Cc/Bcc button moves focus to the Cc field", async () => {
  await composer();
  const button = screen.getByRole("button", { name: "Cc/Bcc" });
  button.focus();
  await userEvent.setup().keyboard("{Enter}");
  await eventually(() =>
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Cc" })),
  );
});

// Shift-Backspace with Shift still held from a capital letter hid the highlighted suggestion for
// good, with only a screen reader announcement and no way back.
it("Shift-Backspace edits the text; forward Delete stops suggesting, shows it and can be undone", async () => {
  const user = await composer();
  await typeAndWait(user, "jor");
  await eventually(() => expect(to().getAttribute("aria-activedescendant")).toBeTruthy());
  await user.keyboard("{Shift>}{Backspace}{/Shift}");
  await eventually(() => expect(to()).toHaveProperty("value", "jo"));
  expect(hidden.size).toBe(0);
  await typeAndWait(user, "r");
  await eventually(() => expect(to().getAttribute("aria-activedescendant")).toBeTruthy());
  await user.keyboard("{Delete}");
  await eventually(() => expect(hidden).toEqual(new Set([work.address])));
  expect(to()).toHaveProperty("value", "jor");
  const status = screen.getAllByText(`Stopped suggesting ${work.address}`);
  expect(status.some((element) => !element.closest(".sr-only"))).toBe(true);
  await eventually(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  await user.click(screen.getByRole("button", { name: "Undo" }));
  await eventually(() => expect(hidden.size).toBe(0));
  expect(document.activeElement).toBe(to());
  // The click left the field's text as it was, not turned into a chip.
  expect(to()).toHaveProperty("value", "jor");
  expect(chip("jor")).toBeNull();
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});

it("Tab to Undo after hiding the last suggestion keeps the typed text, and says where Undo is", async () => {
  const user = await composer();
  await typeAndWait(user, "jor");
  for (const address of [work.address, home.address]) {
    await eventually(() => expect(to().getAttribute("aria-activedescendant")).toBeTruthy());
    await user.keyboard("{Delete}");
    await eventually(() => expect(hidden.has(address)).toBe(true));
  }
  await eventually(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  expect([...document.querySelectorAll("output[aria-live]")].map((o) => o.textContent)).toContain(
    `Stopped suggesting ${home.address}. Undo follows this field.`,
  );
  // The visible status names the whole address even where it truncates.
  expect(screen.getByTitle(home.address).textContent).toBe(`Stopped suggesting ${home.address}`);
  await user.keyboard("{Tab}");
  const undo = screen.getByRole("button", { name: "Undo" });
  expect(document.activeElement).toBe(undo);
  expect(chip("jor")).toBeNull();
  expect(to()).toHaveProperty("value", "jor");
  await user.keyboard("{Enter}");
  await eventually(() => expect(hidden).toEqual(new Set([work.address])));
  expect(document.activeElement).toBe(to());
  expect(to()).toHaveProperty("value", "jor");
  expect(chip("jor")).toBeNull();
  // Leaving the field by way of Undo turns the text into a chip, as Tab from the field does.
  await user.keyboard("{Backspace}r");
  await eventually(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  await eventually(() => expect(to().getAttribute("aria-activedescendant")).toBeTruthy());
  await user.keyboard("{Delete}");
  await eventually(() => expect(hidden.size).toBe(2));
  await eventually(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
  await user.keyboard("{Tab}");
  await eventually(() => expect(chip("jor")).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
});
