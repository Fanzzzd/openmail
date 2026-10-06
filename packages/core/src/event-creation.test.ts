import { afterAll, beforeAll, vi } from "vitest";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  detectMailEvents,
  calendarEventIcs,
  editCalendarEvent,
  calendarTimestamp,
  type CalendarEvent,
} from "./calendar.js";
import { calendarParseDates, calendarDateCandidates, calendarWallTime } from "./event-dates.js";
import { EventRecurrence, eventRecurrenceRule } from "./event-recurrence.js";
import { makeProviderCalendar } from "./provider-calendar.js";
import type { Account } from "./domain.js";

beforeAll(() => vi.stubEnv("TZ", "UTC"));
afterAll(() => vi.unstubAllEnvs());
const context = { reference: Date.parse("2026-10-06T01:00:00Z"), timeZone: "Asia/Shanghai" };
it("English and Chinese deterministic date table uses an explicit reference and zone", () => {
  for (const [input, start, end] of [
    ["next Tuesday", "2026-10-13", "2026-10-14"],
    ["tomorrow 9am–10am", "2026-10-07T09:00:00", "2026-10-07T10:00:00"],
    ["明天中午十一点", "2026-10-07T11:00:00", "2026-10-07T12:00:00"],
    ["tomorrow 3pm", "2026-10-07T15:00:00", "2026-10-07T16:00:00"],
    ["in 2 weeks", "2026-10-20", "2026-10-21"],
    ["end of month", "2026-10-31", "2026-11-01"],
    ["noon today", "2026-10-06T12:00:00", "2026-10-06T13:00:00"],
    ["today 3–5pm", "2026-10-06T15:00:00", "2026-10-06T17:00:00"],
    ["tomorrow 3–5pm", "2026-10-07T15:00:00", "2026-10-07T17:00:00"],
    ["Oct 12–14", "2026-10-12", "2026-10-15"],
    ["Oct 12–14, 2027", "2027-10-12", "2027-10-15"],
    ["下周二下午三点", "2026-10-13T15:00:00", "2026-10-13T16:00:00"],
    ["明天中午三点", "2026-10-07T15:00:00", "2026-10-07T16:00:00"],
    ["明天中午", "2026-10-07T12:00:00", "2026-10-07T13:00:00"],
    ["10月12日至14日", "2026-10-12", "2026-10-15"],
    ["两周后", "2026-10-20", "2026-10-21"],
    ["月底", "2026-10-31", "2026-11-01"],
    ["明天下午三点半", "2026-10-07T15:30:00", "2026-10-07T16:30:00"],
    ["2026-10-10 09:00 to 10:30", "2026-10-10T09:00:00", "2026-10-10T10:30:00"],
    ["2026-10-12–2026-10-14", "2026-10-12", "2026-10-15"],
    ["2026-10-10T09:00:30", "2026-10-10T09:00:30", "2026-10-10T10:00:30"],
  ]) {
    assert.ok(input && start && end);
    const parsed = calendarParseDates(input, context);
    assert.strictEqual(parsed.kind, "parsed", input);
    if (parsed.kind !== "parsed") continue;
    assert.strictEqual(parsed.start.value, start, input);
    assert.strictEqual(parsed.end.value, end, input);
    // Detection and typing must use the exact same complete candidate.
    assert.strictEqual(calendarDateCandidates(input)[0]?.input, input, input);
    const [detected] = detectMailEvents(
      { subject: "Trip", bodyText: `Meeting: ${input}.`, date: context.reference },
      context,
    );
    // Prose offers all-day dates up to about a year ahead.
    const offered = parsed.start.kind !== "date" || parsed.start.value < "2027-10-07";
    assert.deepStrictEqual(detected?.start, offered ? parsed.start : undefined, input);
  }
});
it("ambiguous dates ask for explicit input in both languages; malformed dates never normalize", () => {
  const friday = { ...context, reference: Date.parse("2026-10-09T01:00:00Z") };
  for (const input of [
    "Friday",
    "周五",
    "星期五",
    "03/04",
    "03/04/2026",
    "明天三点",
    "tomorrow 3",
    "noon",
    "3–5pm",
    "3pm",
    "11–1pm",
    "tomorrow evening",
    "tomorrow 3pm–7",
    "tomorrow 5pm–3pm",
    "明天上午十二点",
    "明天晚上十二点",
  ]) {
    assert.strictEqual(calendarParseDates(input, friday).kind, "ambiguous", input);
  }
  for (const input of [
    "2026-02-30",
    "2月30日",
    "Oct 14–12",
    "2026-10-10 24:30",
    "tomorrow 12:80",
    "random prose",
    "2026-10-10T09:00:80",
  ]) {
    assert.strictEqual(calendarParseDates(input, context).kind, "invalid", input);
  }
  assert.deepStrictEqual(calendarParseDates("next Friday", friday).kind, "parsed");
  const [candidate] = detectMailEvents(
    { subject: "Trip", bodyText: "Meet Friday", date: friday.reference },
    friday,
  );
  assert.ok(candidate);
  assert.strictEqual(candidate.dateInput, "Friday");
  assert.ok(Number.isNaN(calendarTimestamp(candidate.start)));
  assert.throws(() => editCalendarEvent(candidate, {}, friday.reference));
  const resolved = editCalendarEvent(
    candidate,
    { dates: { input: "2026-10-16 15:00", timeZone: friday.timeZone } },
    friday.reference,
  );
  assert.strictEqual(resolved.start.value, "2026-10-16T15:00:00");
});
it("DST gaps fail and folds ask; offsets explicitly resolve a fold; relative days preserve local dates", () => {
  const ny = { reference: Date.parse("2026-03-07T14:00:00Z"), timeZone: "America/New_York" };
  assert.strictEqual(calendarParseDates("2026-03-08 02:30", ny).kind, "ambiguous");
  assert.deepStrictEqual(calendarParseDates("2026-11-01 01:30", ny), {
    kind: "ambiguous",
    reason: "dst",
  });
  for (const offset of ["-04:00", "-05:00"]) {
    const parsed = calendarParseDates(`2026-11-01T01:30${offset}`, ny);
    assert.strictEqual(parsed.kind, "parsed");
    if (parsed.kind === "parsed")
      assert.strictEqual(
        calendarTimestamp(parsed.start),
        Date.parse(`2026-11-01T01:30:00${offset}`),
      );
  }
  const tomorrow = calendarParseDates("tomorrow 3pm", ny);
  assert.strictEqual(tomorrow.kind, "parsed");
  if (tomorrow.kind === "parsed")
    assert.strictEqual(calendarTimestamp(tomorrow.start), Date.parse("2026-03-08T19:00:00Z"));
  const tokyo = calendarParseDates("tomorrow", {
    reference: Date.parse("2026-12-31T23:00:00Z"),
    timeZone: "Asia/Tokyo",
  });
  if (tokyo.kind === "parsed") assert.strictEqual(tokyo.start.value, "2027-01-02");
  const leap = calendarParseDates("end of month", {
    ...context,
    reference: Date.parse("2028-02-01T01:00:00Z"),
  });
  if (leap.kind === "parsed") assert.strictEqual(leap.end.value, "2028-03-01");
});
const event: CalendarEvent = {
  key: "new-event",
  title: "Trip",
  description: "",
  location: "",
  recurrence: [],
  start: {
    kind: "zoned",
    value: "2026-10-26T09:00:00",
    timestamp: Date.parse("2026-10-26T13:00:00Z"),
    zone: "America/New_York",
  },
  end: {
    kind: "zoned",
    value: "2026-10-26T10:00:00",
    timestamp: Date.parse("2026-10-26T14:00:00Z"),
    zone: "America/New_York",
  },
};
const account: Account = {
  id: "a",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const patterns: [EventRecurrence["pattern"], string, unknown][] = [
  [{ kind: "daily", interval: 2 }, "FREQ=DAILY;INTERVAL=2", { type: "daily", interval: 2 }],
  [
    { kind: "weekly", interval: 2, weekdays: ["MO", "WE"] },
    "FREQ=WEEKLY;BYDAY=MO,WE;WKST=MO;INTERVAL=2",
    { type: "weekly", interval: 2, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "monday" },
  ],
  [
    { kind: "monthly-date", interval: 3, day: 26 },
    "FREQ=MONTHLY;BYMONTHDAY=26;INTERVAL=3",
    { type: "absoluteMonthly", interval: 3, dayOfMonth: 26 },
  ],
  [
    { kind: "yearly-date", interval: 2, day: 26, month: 10 },
    "FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=26;INTERVAL=2",
    { type: "absoluteYearly", interval: 2, dayOfMonth: 26, month: 10 },
  ],
  [
    { kind: "monthly-weekday", interval: 2, weekday: "MO", ordinal: -1 },
    "FREQ=MONTHLY;BYDAY=-1MO;INTERVAL=2",
    { type: "relativeMonthly", interval: 2, daysOfWeek: ["monday"], index: "last" },
  ],
  [
    { kind: "monthly-weekday", interval: 2, weekday: "MO", ordinal: 4 },
    "FREQ=MONTHLY;BYDAY=4MO;INTERVAL=2",
    { type: "relativeMonthly", interval: 2, daysOfWeek: ["monday"], index: "fourth" },
  ],
  [
    { kind: "yearly-weekday", interval: 2, month: 10, weekday: "MO", ordinal: -1 },
    "FREQ=YEARLY;BYMONTH=10;BYDAY=-1MO;INTERVAL=2",
    { type: "relativeYearly", interval: 2, daysOfWeek: ["monday"], index: "last", month: 10 },
  ],
];
it.effect(
  "every creation pattern and ending produces exact Google RRULE and Graph bodies through fake HTTP",
  () =>
    Effect.gen(function* () {
      for (const [pattern, base, graphPattern] of patterns) {
        for (const ending of [
          { kind: "never" },
          { kind: "count", count: 5 },
          { kind: "until", date: "2026-11-03" },
        ] satisfies EventRecurrence["ending"][]) {
          const rule = { pattern, ending };
          const recurrence = eventRecurrenceRule(rule, event.start);
          const suffix =
            ending.kind === "never"
              ? ""
              : ending.kind === "count"
                ? ";COUNT=5"
                : ";UNTIL=20261104T045959Z";
          assert.strictEqual(recurrence, `RRULE:${base}${suffix}`);
          const updated = editCalendarEvent(event, { recurrence: rule }, context.reference);
          for (const provider of ["gmail", "outlook"] satisfies ("gmail" | "outlook")[]) {
            const reads: string[] = [],
              posts: unknown[] = [];
            const adapter = makeProviderCalendar(
              provider,
              <A>(_id: string, schema: Schema.Decoder<A>, path: string) => {
                reads.push(path);
                return Schema.decodeUnknownEffect(schema)(
                  provider === "gmail" ? { items: [] } : { value: [] },
                ).pipe(Effect.orDie);
              },
              (_id, _path, body) =>
                Effect.sync(() => {
                  posts.push(body);
                }),
            );
            yield* adapter.createCalendarEvent({ ...account, provider }, updated);
            assert.strictEqual(posts.length, 1);
            const body = Schema.decodeUnknownSync(
              Schema.Struct({
                recurrence: Schema.Unknown,
                start: Schema.Unknown,
                end: Schema.Unknown,
              }),
            )(posts[0]);
            if (provider === "gmail") {
              assert.deepStrictEqual(body.recurrence, [recurrence]);
              assert.deepStrictEqual(body.start, {
                dateTime: "2026-10-26T13:00:00.000Z",
                timeZone: "America/New_York",
              });
              assert.deepStrictEqual(body.end, {
                dateTime: "2026-10-26T14:00:00.000Z",
                timeZone: "America/New_York",
              });
            } else {
              assert.deepStrictEqual(body.start, {
                dateTime: "2026-10-26T09:00:00",
                timeZone: "America/New_York",
              });
              assert.deepStrictEqual(body.end, {
                dateTime: "2026-10-26T10:00:00",
                timeZone: "America/New_York",
              });
              assert.deepStrictEqual(body.recurrence, {
                pattern: graphPattern,
                range: {
                  startDate: "2026-10-26",
                  recurrenceTimeZone: "America/New_York",
                  ...(ending.kind === "never"
                    ? { type: "noEnd" }
                    : ending.kind === "count"
                      ? { type: "numbered", numberOfOccurrences: 5 }
                      : { type: "endDate", endDate: "2026-11-03" }),
                },
              });
            }
          }
        }
      }
    }),
);
it("UNTIL uses the last day's DST offset and all-day DATE form; invalid repeat inputs fail", () => {
  const rule: EventRecurrence = {
    pattern: { kind: "daily", interval: 1 },
    ending: { kind: "until", date: "2027-03-14" },
  };
  assert.strictEqual(
    eventRecurrenceRule(rule, event.start),
    "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20270315T035959Z",
  );
  assert.strictEqual(
    eventRecurrenceRule(rule, { kind: "date", value: "2026-10-26" }),
    "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20270314",
  );
  assert.throws(() =>
    eventRecurrenceRule({ ...rule, ending: { kind: "until", date: "2026-02-31" } }, event.start),
  );
  assert.throws(() =>
    eventRecurrenceRule({ ...rule, ending: { kind: "until", date: "2025-12-31" } }, event.start),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EventRecurrence)({
      ...rule,
      pattern: { kind: "weekly", interval: 1, weekdays: [] },
    }),
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(EventRecurrence)({ ...rule, pattern: { kind: "daily", interval: 0 } }),
  );
});
it.effect(
  "Outlook rejects lossy month dates before reads or posts; Google supports the exact rule",
  () =>
    Effect.gen(function* () {
      for (const [start, pattern] of [
        ["2026-10-31", { kind: "monthly-date", interval: 1, day: 31 }],
        ["2028-02-29", { kind: "yearly-date", interval: 1, day: 29, month: 2 }],
      ] satisfies [string, EventRecurrence["pattern"]][]) {
        const recurrence = eventRecurrenceRule(
          { pattern, ending: { kind: "never" } },
          { kind: "date", value: start },
        );
        const updated = {
          ...event,
          start: { kind: "date", value: start },
          end: { kind: "date", value: start.slice(0, 8) + (Number(start.slice(8)) + 1) },
          recurrence: [recurrence],
        } satisfies CalendarEvent;
        // Keep a valid exclusive end across the month boundary.
        const next = new Date(Date.parse(`${start}T00:00:00Z`) + 86400000)
          .toISOString()
          .slice(0, 10);
        for (const provider of ["gmail", "outlook"] satisfies ("gmail" | "outlook")[]) {
          let calls = 0;
          const adapter = makeProviderCalendar(
            provider,
            <A>(_id: string, schema: Schema.Decoder<A>) => {
              calls++;
              return Schema.decodeUnknownEffect(schema)({ items: [] }).pipe(Effect.orDie);
            },
            () =>
              Effect.sync(() => {
                calls++;
              }),
          );
          const result = yield* adapter
            .createCalendarEvent(
              { ...account, provider },
              { ...updated, end: { kind: "date", value: next } },
            )
            .pipe(Effect.result);
          assert.strictEqual(result._tag, provider === "gmail" ? "Success" : "Failure");
          assert.strictEqual(calls, provider === "gmail" ? 2 : 0);
        }
      }
    }),
);
it("wall conversion accepts Windows zones without importing any Node platform", () => {
  assert.strictEqual(
    calendarWallTime(Date.parse("2026-11-02T14:00:00Z"), "Eastern Standard Time"),
    "2026-11-02T09:00:00",
  );
});

it.effect("all monthly weekday positions, including fifth and last, keep their exact meaning", () =>
  Effect.gen(function* () {
    for (const ordinal of [1, 2, 3, 4, 5, -1] satisfies (1 | 2 | 3 | 4 | 5 | -1)[]) {
      const date =
        ordinal === 5
          ? "2026-11-30"
          : `2026-10-${String(ordinal === -1 ? 26 : ordinal * 7 - 2).padStart(2, "0")}`;
      const pattern: EventRecurrence["pattern"] = {
        kind: "monthly-weekday",
        interval: 3,
        weekday: "MO",
        ordinal,
      };
      const input: CalendarEvent = {
        ...event,
        start: { kind: "date", value: date },
        end: {
          kind: "date",
          value: new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
        },
        recurrence: [
          eventRecurrenceRule(
            { pattern, ending: { kind: "count", count: 2 } },
            { kind: "date", value: date },
          ),
        ],
      };
      assert.strictEqual(
        input.recurrence[0],
        `RRULE:FREQ=MONTHLY;BYDAY=${ordinal}MO;INTERVAL=3;COUNT=2`,
      );
      for (const provider of ["gmail", "outlook"] satisfies ("gmail" | "outlook")[]) {
        const posts: unknown[] = [];
        let reads = 0;
        const adapter = makeProviderCalendar(
          provider,
          <A>(_id: string, schema: Schema.Decoder<A>) => {
            reads++;
            return Schema.decodeUnknownEffect(schema)({ items: [] }).pipe(Effect.orDie);
          },
          (_id, _path, body) =>
            Effect.sync(() => {
              posts.push(body);
            }),
        );
        const result = yield* adapter
          .createCalendarEvent({ ...account, provider }, input)
          .pipe(Effect.result);
        const unsupported = ordinal === 5 && provider === "outlook";
        assert.strictEqual(result._tag, unsupported ? "Failure" : "Success");
        assert.strictEqual(posts.length, unsupported ? 0 : 1);
        assert.strictEqual(reads, provider === "gmail" ? 1 : 0);
        if (provider === "outlook" && !unsupported) {
          const body = Schema.decodeUnknownSync(Schema.Struct({ recurrence: Schema.Unknown }))(
            posts[0],
          );
          const indexes = {
            1: "first",
            2: "second",
            3: "third",
            4: "fourth",
            5: "fifth",
            "-1": "last",
          };
          assert.deepStrictEqual(body.recurrence, {
            pattern: {
              type: "relativeMonthly",
              interval: 3,
              daysOfWeek: ["monday"],
              index: indexes[ordinal],
            },
            range: {
              type: "numbered",
              numberOfOccurrences: 2,
              startDate: date,
              recurrenceTimeZone: "UTC",
            },
          });
        }
      }
    }
  }),
);

it("detection does not truncate Chinese clocks or match English dates inside unrelated words", () => {
  assert.deepStrictEqual(
    calendarDateCandidates("Tomorrowland; afternoonish; the noontime train"),
    [],
  );
});

it("downloaded recurrence preserves the event TZID rather than fixing future occurrences to UTC", () => {
  const recurring = editCalendarEvent(
    event,
    {
      recurrence: {
        pattern: { kind: "weekly", interval: 1, weekdays: ["MO"] },
        ending: { kind: "until", date: "2026-11-03" },
      },
    },
    context.reference,
  );
  const file = calendarEventIcs(recurring);
  assert.match(file, /DTSTART;TZID=America\/New_York:20261026T090000/);
  assert.match(file, /DTEND;TZID=America\/New_York:20261026T100000/);
  assert.match(file, /UNTIL=20261104T045959Z/);
});

it("detection keeps ambiguous range endpoints and rejects truncated numbers and clocks", () => {
  const reference = { subject: "Trip", date: context.reference };
  for (const input of ["tomorrow 3pm–7", "tomorrow 3"]) {
    const [candidate] = detectMailEvents({ ...reference, bodyText: `Call ${input}` }, context);
    assert.strictEqual(candidate?.dateInput, input);
    assert.ok(candidate && Number.isNaN(calendarTimestamp(candidate.start)));
  }
  for (const input of ["tomorrow 3pmish", "10月123日", "Oct 123", "2026-10-10T09:00:00.000Z"]) {
    assert.deepStrictEqual(detectMailEvents({ ...reference, bodyText: input }, context), [], input);
  }
});

it.effect(
  "Google and Outlook reject a mismatched rule before fake HTTP; edited content has a new duplicate identity",
  () =>
    Effect.gen(function* () {
      for (const provider of ["gmail", "outlook"] satisfies ("gmail" | "outlook")[]) {
        const posts: unknown[] = [];
        let reads = 0;
        const adapter = makeProviderCalendar(
          provider,
          <A>(_id: string, schema: Schema.Decoder<A>) => {
            reads++;
            return Schema.decodeUnknownEffect(schema)({ items: [] }).pipe(Effect.orDie);
          },
          (_id, _path, body) =>
            Effect.sync(() => {
              posts.push(body);
            }),
        );
        const failed = yield* adapter
          .createCalendarEvent(
            { ...account, provider },
            { ...event, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=3"] },
          )
          .pipe(Effect.result);
        assert.strictEqual(failed._tag, "Failure");
        assert.strictEqual(reads, 0);
        assert.strictEqual(posts.length, 0);
        yield* adapter.createCalendarEvent({ ...account, provider }, event);
        yield* adapter.createCalendarEvent({ ...account, provider }, event);
        yield* adapter.createCalendarEvent(
          { ...account, provider },
          { ...event, title: "Edited title" },
        );
        assert.strictEqual(posts.length, 2);
        const keySchema =
          provider === "gmail"
            ? Schema.Struct({ iCalUID: Schema.String })
            : Schema.Struct({ transactionId: Schema.String });
        assert.notStrictEqual(
          Schema.decodeUnknownSync(keySchema)(posts[0]),
          Schema.decodeUnknownSync(keySchema)(posts[1]),
        );
      }
    }),
);
it("changing a start date flags a pattern mismatch even before provider selection", () => {
  const recurring = editCalendarEvent(
    event,
    {
      recurrence: {
        pattern: { kind: "weekly", weekdays: ["MO"], interval: 1 },
        ending: { kind: "count", count: 3 },
      },
    },
    context.reference,
  );
  assert.throws(() =>
    editCalendarEvent(
      recurring,
      { dates: { input: "2026-10-27 09:00", timeZone: "America/New_York" } },
      context.reference,
    ),
  );
});

it.effect(
  "an edited published event creates a personal copy instead of being swallowed by the original Google UID",
  () =>
    Effect.gen(function* () {
      const published = { ...event, uid: "published@example.com" };
      const copy = editCalendarEvent(
        published,
        { dates: { input: "2026-10-27 09:00", timeZone: "America/New_York" } },
        context.reference,
      );
      assert.strictEqual(copy.uid, undefined);
      assert.strictEqual(editCalendarEvent(published, {}, context.reference).uid, published.uid);
      const posts: unknown[] = [];
      const adapter = makeProviderCalendar(
        "gmail",
        <A>(_id: string, schema: Schema.Decoder<A>, path: string) =>
          Schema.decodeUnknownEffect(schema)({
            items:
              new URL(path).searchParams.get("iCalUID") === published.uid
                ? [{ id: "original" }]
                : [],
          }).pipe(Effect.orDie),
        (_id, _path, body) =>
          Effect.sync(() => {
            posts.push(body);
          }),
      );
      yield* adapter.createCalendarEvent(account, published);
      assert.strictEqual(posts.length, 0);
      yield* adapter.createCalendarEvent(account, copy);
      yield* adapter.createCalendarEvent(account, copy);
      assert.strictEqual(posts.length, 1);
    }),
);
it.effect(
  "every supported date pattern rejects mismatched DTSTART without reading or writing HTTP",
  () =>
    Effect.gen(function* () {
      for (const rule of [
        "FREQ=WEEKLY;BYDAY=TU",
        "FREQ=MONTHLY;BYMONTHDAY=25",
        "FREQ=MONTHLY;BYDAY=1MO",
        "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1",
        "FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=26",
        "FREQ=YEARLY;BYMONTH=10;BYDAY=-1TU",
      ]) {
        for (const provider of ["gmail", "outlook"] satisfies ("gmail" | "outlook")[]) {
          let calls = 0;
          const adapter = makeProviderCalendar(
            provider,
            () =>
              Effect.sync(() => {
                calls++;
                throw new Error("Must not read");
              }),
            () =>
              Effect.sync(() => {
                calls++;
              }),
          );
          const result = yield* adapter
            .createCalendarEvent(
              { ...account, provider },
              { ...event, recurrence: [`RRULE:${rule};COUNT=3`] },
            )
            .pipe(Effect.result);
          assert.strictEqual(result._tag, "Failure", rule);
          assert.strictEqual(calls, 0);
        }
      }
    }),
);
it("recurrence date extraction does not swallow a bad source zone", () => {
  assert.throws(() =>
    eventRecurrenceRule(
      { pattern: { kind: "daily", interval: 1 }, ending: { kind: "until", date: "2026-12-31" } },
      {
        kind: "zoned",
        zone: "Custom/Unknown",
        value: "2026-10-26T09:00:00",
        timestamp: Date.parse("2026-10-26T13:00:00Z"),
      },
    ),
  );
});

it("prose detection skips newsletter dates and keeps a meeting request", () => {
  const newsletter = [
    "Your Daily Brief is ready | 3:12 read time",
    "Nuclear reactors run 24/7, and operators re-up on uranium every 18 to 24 months.",
    "We added the stock back in January 2025.",
    "👀 Today's Research: tech ETFs ticked higher premarket Tuesday.",
    "That’s today’s Insight. What others like you are reading today...",
    "Security alert: a new sign-in today at 8:30am. 会议室 星期日 开放。",
    "Offer valid 10/1 - 10/31. Estimated delivery Oct 10-12. Sale runs Oct 10 to Oct 20.",
    "Join our webinar series to learn more about our new range of products. Sale ends Oct 31.",
    "Stay tuned for Friday.",
    "Best Flight Deals Today!",
  ].join("\n");
  assert.deepStrictEqual(
    detectMailEvents({ subject: "Digest", bodyText: newsletter, date: context.reference }, context),
    [],
  );
  const request = [
    "Hi Ana,",
    "Can we have a call tomorrow 3pm to go through the draft?",
    "Otherwise the meeting on Friday works too, or Friday at the latest.",
    "How about a sync Thursday?",
    "The workshop runs Oct 12–14 and the deadline for comments is Oct 20.",
    "Deadline: 15 November. Dentist on 21 Oct. Dinner on the 14th.",
    "Flight CX123 departs 12 Oct 08:55. Hotel check-in Oct 25–27.",
    "I was out on 2026-09-30, sorry for the delay. The office is open 24/7.",
  ].join("\n");
  const found = detectMailEvents(
    { subject: "Draft review", bodyText: request, date: context.reference },
    context,
  );
  assert.deepStrictEqual(
    found.map((event) => [event.dateInput, event.start.value]),
    [
      ["tomorrow 3pm", "2026-10-07T15:00:00"],
      ["on Friday", "2026-10-09"],
      ["Thursday", "2026-10-08"],
      ["Oct 12–14", "2026-10-12"],
      ["Oct 20", "2026-10-20"],
    ],
  );
});

it("prose detection reads day-first dates, the day of the month and a 24-hour clock", () => {
  const found = detectMailEvents(
    {
      subject: "Plans",
      bodyText: [
        "Deadline: 15 November.",
        "Dentist on 21 Oct.",
        "Dinner on the 14th.",
        "Flight CX123 departs 12 Oct 08:55.",
        "Hotel check-in Oct 25–27, Sunday.",
        "预约 10月30日。",
      ].join("\n"),
      date: context.reference,
    },
    context,
  );
  assert.deepStrictEqual(
    found.map((event) => [event.dateInput, event.start.value]),
    [
      ["15 November", "2026-11-15"],
      ["on 21 Oct", "2026-10-21"],
      ["on the 14th", "2026-10-14"],
      ["12 Oct 08:55", "2026-10-12T08:55:00"],
      ["Oct 25–27", "2026-10-25"],
    ],
  );
});

it("prose detection caps a list of dated items", () => {
  const agenda = Array.from({ length: 9 }, (_, day) => `Meeting 2026-10-${10 + day} 09:00`).join(
    "\n",
  );
  assert.strictEqual(
    detectMailEvents({ subject: "Agenda", bodyText: agenda, date: context.reference }, context)
      .length,
    5,
  );
});

it("ordinal days need a preposition and never swallow a month or a counted noun", () => {
  const detect = (bodyText: string, reference = context.reference) =>
    detectMailEvents(
      { subject: "Plans", bodyText, date: reference },
      { ...context, reference },
    ).map((event) => [event.dateInput, event.start.value]);
  assert.deepStrictEqual(detect("Party on the 4th of July."), [
    ["on the 4th of July", "2027-07-04"],
  ]);
  assert.deepStrictEqual(detect("Dinner by the 14th."), [["by the 14th", "2026-10-14"]]);
  assert.deepStrictEqual(detect("Our conference celebrates the 21st century."), []);
  assert.deepStrictEqual(detect("He won the 1st place at the conference."), []);
  assert.deepStrictEqual(detect("Meeting on the 2nd floor."), []);
  assert.deepStrictEqual(detect("The conference marks the 10th anniversary."), []);
  // November has no 31st, so the next month that has one is used.
  assert.deepStrictEqual(detect("Dinner on the 31st.", Date.parse("2026-11-05T01:00:00Z")), [
    ["on the 31st", "2026-12-31"],
  ]);
});
