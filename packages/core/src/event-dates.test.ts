import { assert, it } from "@effect/vitest";
import { calendarParseDates, calendarDateCandidates } from "./event-dates.js";
import { validateEventRecurrenceForProvider } from "./event-recurrence.js";
import type { CalendarEvent } from "./calendar.js";
const context = { reference: Date.parse("2026-12-20T12:00:00Z"), timeZone: "UTC" };
it("typed and detected dates share year rolling, ranges and Chinese periods", () => {
  for (const [input, start, end] of [
    ["Jan 5", "2027-01-05", "2027-01-06"],
    ["1月5日", "2027-01-05", "2027-01-06"],
    ["1月1号", "2027-01-01", "2027-01-02"],
    ["明年1月5日凌晨一点", "2027-01-05T01:00:00", "2027-01-05T02:00:00"],
    ["noon tomorrow", "2026-12-21T12:00:00", "2026-12-21T13:00:00"],
    ["tomorrow at noon", "2026-12-21T12:00:00", "2026-12-21T13:00:00"],
    ["明天中午", "2026-12-21T12:00:00", "2026-12-21T13:00:00"],
    ["Oct 31 – Nov 2", "2027-10-31", "2027-11-03"],
    ["10月31日至11月2日", "2027-10-31", "2027-11-03"],
    ["13/4", "2027-04-13", "2027-04-14"],
    ["明天下午三点至五点", "2026-12-21T15:00:00", "2026-12-21T17:00:00"],
  ]) {
    assert.ok(input && start && end);
    const parsed = calendarParseDates(input, context);
    assert.strictEqual(parsed.kind, "parsed", input);
    if (parsed.kind === "parsed") {
      assert.strictEqual(parsed.start.value, start, input);
      assert.strictEqual(parsed.end.value, end, input);
    }
    assert.deepStrictEqual(
      calendarDateCandidates(input).map((c) => c.input),
      [input],
      input,
    );
  }
});
it("weekday, clock and DST ambiguities remain explicit; prices and versions are excluded", () => {
  const thursday = { ...context, reference: Date.parse("2026-10-08T12:00:00Z") };
  for (const input of ["next Friday", "noon", "3pm", "3–5pm", "tomorrow 7:30"])
    assert.strictEqual(calendarParseDates(input, thursday).kind, "ambiguous", input);
  assert.deepStrictEqual(
    calendarParseDates("2026-03-08 02:30", { ...context, timeZone: "America/New_York" }),
    { kind: "ambiguous", reason: "dst" },
  );
  assert.deepStrictEqual(calendarDateCandidates("Price $3.50; v1.2; 1.2.3; USD 13.4"), []);
});
it("a rule that omits DTSTART fails for Google as well as Outlook", () => {
  const event: CalendarEvent = {
    key: "a",
    title: "a",
    description: "",
    location: "",
    start: { kind: "date", value: "2026-10-26" },
    end: { kind: "date", value: "2026-10-27" },
    recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3"],
  };
  assert.throws(() => validateEventRecurrenceForProvider(event, "gmail"));
});

it("every English weekday pair follows the documented next/this/bare rule", () => {
  const names = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (let current = 0; current < 7; current++) {
    const reference = Date.parse("2026-10-04T12:00:00Z") + current * 86400000;
    for (let target = 0; target < 7; target++) {
      const name = names[target];
      assert.ok(name);
      const delta = (target - current + 7) % 7;
      for (const modifier of ["", "this ", "next "]) {
        const parsed = calendarParseDates(modifier + name, { reference, timeZone: "UTC" });
        const ambiguous = modifier === "" ? delta === 0 : modifier === "next " && delta !== 0;
        assert.strictEqual(
          parsed.kind,
          ambiguous ? "ambiguous" : "parsed",
          `${current}, ${modifier}${name}`,
        );
        if (parsed.kind === "parsed") {
          const days = modifier === "next " ? 7 : delta;
          assert.strictEqual(
            parsed.start.value,
            new Date(reference + days * 86400000).toISOString().slice(0, 10),
          );
        }
      }
      for (const modifier of ["周", "本周", "下周"]) {
        const parsed = calendarParseDates(modifier + "日一二三四五六"[target], {
          reference,
          timeZone: "UTC",
        });
        const ambiguous = modifier === "周" && delta === 0;
        assert.strictEqual(parsed.kind, ambiguous ? "ambiguous" : "parsed");
        if (parsed.kind === "parsed") {
          const days =
            modifier === "下周"
              ? target - current + (current === 0 ? -7 : 0) + (target === 0 ? 7 : 0) + 7
              : delta;
          assert.strictEqual(
            parsed.start.value,
            new Date(reference + days * 86400000).toISOString().slice(0, 10),
          );
        }
      }
    }
  }
});
it("cross-year ranges keep their full span and explicit years do not roll", () => {
  for (const input of ["Dec 31–Jan 2", "12月31日至1月2号"]) {
    const parsed = calendarParseDates(input, context);
    assert.strictEqual(parsed.kind, "parsed");
    if (parsed.kind === "parsed") {
      assert.strictEqual(parsed.start.value, "2026-12-31");
      assert.strictEqual(parsed.end.value, "2027-01-03");
    }
  }
  const historical = calendarParseDates("Jan 5, 2026", context);
  if (historical.kind === "parsed") assert.strictEqual(historical.start.value, "2026-01-05");
  assert.strictEqual(calendarParseDates("tomorrow 13:30", context).kind, "parsed");
});
