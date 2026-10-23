import { afterAll, beforeAll, afterEach, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import userEvent from "@testing-library/user-event";
import { flow, incoming, row, eventually } from "./harness";
beforeAll(() => vi.stubEnv("TZ", "UTC"));
afterAll(() => vi.unstubAllEnvs());
let current: Awaited<ReturnType<typeof flow>> | undefined;
/** Dates in prose must not be in the past, so these messages carry a fixed date. */
const OCTOBER = Date.parse("2026-10-01T12:00:00Z");
/** Dates found in the message text share one row; its menu opens the event dialog. */
async function openTextDate() {
  await eventually(() =>
    expect(screen.getByRole("button", { name: /dates? found$/ })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: /dates? found$/ }));
  const [item] = await screen.findAllByRole("menuitem");
  if (!item) throw new Error("Missing date menu item");
  fireEvent.click(item);
}
/** Picks an option from a Select the way a person does: open the list, click the option. */
async function choose(label: string, option: string) {
  const user = userEvent.setup();
  const trigger = screen.getByRole("combobox", { name: label });
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
  await eventually(() => expect(trigger.textContent).toContain(option));
}
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("event detection uses core results and refreshes same-id body changes without stale confirmation", async () => {
  const reservation = (name: string) =>
    incoming("one", {
      bodyText: "",
      bodyHtml: `<script type="application/ld+json">{"@type":"FlightReservation","reservationFor":{"@type":"Flight","flightNumber":"${name}","departureTime":"2026-10-03T09:00:00Z"}}</script>`,
    });
  current = await flow({ messages: [reservation("AB123")] });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(screen.getByText("AB123")).toBeTruthy());
  expect(
    screen.getByText("End time is estimated. Review it before adding the event."),
  ).toBeTruthy();
  expect(h.requests.some((request) => request.tag === "DetectedEvents")).toBe(true);
  h.server.messages.set("one", reservation("CD456"));
  await h.run(h.m.sync.sync());
  await eventually(() => expect(screen.getByText("CD456")).toBeTruthy());
  expect(screen.queryByText("AB123")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
  await eventually(() =>
    expect(screen.getByRole("dialog", { name: "Add this event to your calendar?" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm and add event" }));
  await eventually(() => expect(h.server.createdEvents[0]?.title).toBe("CD456"));
  expect(h.server.createdEvents[0]?.endEstimated).toBe(true);
});

it("confirmation edits dates and multi-weekday recurrence through RPC with a readable summary", async () => {
  current = await flow({
    messages: [incoming("one", { bodyText: "Meeting 2026-10-26 09:00–10:00", date: OCTOBER })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await openTextDate();
  await choose("Time zone", "America/New_York");
  fireEvent.change(screen.getByLabelText("Event date or range"), {
    target: { value: "2026-10-26 09:00–10:00" },
  });
  await choose("Repeat pattern", "Weekly");
  fireEvent.change(screen.getByLabelText("Interval"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "Wed" }));
  await choose("Ends", "On a date");
  fireEvent.change(screen.getByLabelText("Repeat end date"), { target: { value: "2026-12-31" } });
  expect(screen.getByText("Every 2 weeks on Mon & Wed until Dec 31, 2026")).toBeTruthy();
  expect(h.server.createdEvents).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm and add event" }));
  await eventually(() => expect(h.server.createdEvents).toHaveLength(1));
  expect(h.server.createdEvents[0]?.recurrence).toEqual([
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO;INTERVAL=2;UNTIL=20270101T045959Z",
  ]);
  expect(h.server.createdEvents[0]?.start).toMatchObject({
    kind: "zoned",
    zone: "America/New_York",
    timestamp: Date.parse("2026-10-26T13:00:00Z"),
  });
});

it("ambiguous dates block confirmation until the person chooses an explicit date", async () => {
  current = await flow({
    messages: [
      incoming("one", { date: Date.parse("2026-10-09T12:00:00Z"), bodyText: "Meet Friday" }),
    ],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await openTextDate();
  expect(screen.getByText("This date is ambiguous. Enter an explicit date and time.")).toBeTruthy();
  expect(screen.getByLabelText("Event date or range").getAttribute("aria-invalid")).toBe("true");
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Download calendar file" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Event date or range"), { target: { value: "03/04" } });
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Event date or range"), {
    target: { value: "2026-10-16 15:00" },
  });
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(false);
  await choose("Repeat pattern", "Yearly by date");
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: "0" } });
  expect(screen.getByText("Check the date and repeat settings")).toBeTruthy();
  // A repeat error leaves the parsed date field valid.
  expect(screen.getByLabelText("Event date or range").hasAttribute("aria-invalid")).toBe(false);
  expect(screen.getByLabelText("Month").closest("fieldset")?.hasAttribute("disabled")).toBe(false);
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Month"), { target: { value: "10" } });
  await choose("Ends", "After a number of occurrences");
  fireEvent.change(screen.getByLabelText("Occurrences"), { target: { value: "3" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm and add event" }));
  await eventually(() => expect(h.server.createdEvents).toHaveLength(1));
  expect(h.server.createdEvents[0]?.recurrence).toEqual([
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=16;INTERVAL=1;COUNT=3",
  ]);
});

it("Outlook shows a lossless-mapping error before confirmation for a month-end repeat", async () => {
  current = await flow({
    provider: "outlook",
    messages: [incoming("one", { bodyText: "Workshop 2026-10-31", date: OCTOBER })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await openTextDate();
  await choose("Repeat pattern", "Monthly by date");
  expect(
    screen.getByText("Outlook can't save this repeat pattern. Choose a simpler one."),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(h.server.createdEvents).toHaveLength(0);
  expect(h.requests.some((request) => request.tag === "CreateCalendarEvent")).toBe(false);
});

it("changing the start flags the rule mismatch and leaves the editor available to fix it", async () => {
  current = await flow({
    messages: [incoming("one", { bodyText: "Meeting 2026-10-26 09:00–10:00", date: OCTOBER })],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await openTextDate();
  // A React listbox, not a native <select>.
  fireEvent.click(screen.getByRole("combobox", { name: "Time zone" }));
  expect(await screen.findByRole("option", { name: "America/New_York" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  await eventually(() => expect(screen.queryByRole("listbox")).toBeNull());
  await choose("Repeat pattern", "Weekly");
  fireEvent.change(screen.getByLabelText("Event date or range"), {
    target: { value: "2026-10-27 09:00–10:00" },
  });
  expect(
    screen.getByText(
      "The repeat pattern must include the event's start date. Change the pattern or the start date.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByLabelText("Repeat pattern").closest("fieldset")?.hasAttribute("disabled"),
  ).toBe(false);
  expect(h.requests.some((request) => request.tag === "CreateCalendarEvent")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Tue" }));
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(false);
});
it("DST gaps have an explicit offset prompt before any creation", async () => {
  current = await flow({
    messages: [
      incoming("one", {
        bodyText: "Meeting 2026-03-08 02:30",
        date: Date.parse("2026-03-01T12:00:00Z"),
      }),
    ],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await openTextDate();
  await choose("Time zone", "America/New_York");
  expect(
    screen.getByText(
      "This time is skipped or repeated by daylight saving. Enter a date and time with a UTC offset.",
    ),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Confirm and add event" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(h.server.createdEvents).toHaveLength(0);
});

it("dates in prose share one quiet row instead of a card each", async () => {
  current = await flow({
    messages: [
      incoming("one", {
        bodyText: "Call 2026-10-26 09:00–10:00. The workshop runs Oct 12–14.",
        date: OCTOBER,
      }),
    ],
  });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() =>
    expect(screen.getByRole("button", { name: "2 dates found" })).toBeTruthy(),
  );
  expect(screen.queryByRole("button", { name: "Add to calendar" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "2 dates found" }));
  expect(await screen.findAllByRole("menuitem")).toHaveLength(2);
});
