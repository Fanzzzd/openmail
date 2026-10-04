import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeProviderCalendar } from "./provider-calendar.js";
import { type Account } from "./domain.js";
import { type CalendarEvent } from "./calendar.js";
import { ProviderError } from "./errors.js";
const account: Account = {
  id: "gmail:me@gmail.com",
  provider: "gmail",
  email: "me@gmail.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const event: CalendarEvent = {
  key: "invited-uid",
  title: "Train",
  start: { kind: "floating", value: "2026-10-10T09:00:00" },
  end: { kind: "floating", value: "2026-10-10T10:00:00" },
  location: "Station",
  description: "ticket",
  recurrence: [],
};
function fake(provider: "gmail" | "outlook", pages: readonly unknown[]) {
  const reads: string[] = [],
    writes: { path: string; body: unknown }[] = [];
  const adapter = makeProviderCalendar(
    provider,
    <A>(_id: string, schema: Schema.Decoder<A>, path: string) => {
      reads.push(path);
      return Schema.decodeUnknownEffect(schema)(
        pages[reads.length - 1] ?? (provider === "gmail" ? { items: [] } : { value: [] }),
      ).pipe(Effect.mapError(() => new ProviderError({ message: "Invalid test response" })));
    },
    (_id, path, body) =>
      Effect.sync(() => {
        writes.push({ path, body });
      }),
  );
  return { adapter, reads, writes };
}
it.effect(
  "Google expands recurring instances, paginates a bounded local window, excludes the invite and shows all-day events",
  () =>
    Effect.gen(function* () {
      const item = {
        id: "own",
        summary: "Busy",
        start: { date: "2026-10-10" },
        end: { date: "2026-10-11" },
      };
      const f = fake("gmail", [
        {
          items: [
            item,
            { ...item, id: "cancelled", status: "cancelled" },
            { ...item, id: "free", transparency: "transparent" },
            { ...item, id: "invite", iCalUID: event.key },
          ],
          nextPageToken: "next",
        },
        { items: [{ ...item, id: "recurring-instance" }] },
      ]);
      const found = yield* f.adapter.calendarEvents(account, event);
      assert.deepStrictEqual(
        found.map((e) => e.key),
        ["own", "recurring-instance"],
      );
      assert.deepStrictEqual(found[0]?.start, { kind: "date", value: "2026-10-10" });
      const query = new URL(f.reads[0] ?? "").searchParams;
      assert.strictEqual(query.get("singleEvents"), "true");
      assert.strictEqual(query.get("timeMin"), new Date("2026-10-10T09:00:00").toISOString());
      assert.strictEqual(query.get("timeMax"), new Date("2026-10-10T10:00:00").toISOString());
      assert.strictEqual(query.get("timeZone"), Intl.DateTimeFormat().resolvedOptions().timeZone);
      assert.strictEqual(new URL(f.reads[1] ?? "").searchParams.get("pageToken"), "next");
      const daily = {
        ...event,
        uid: "travel@example.com",
        start: { kind: "date", value: "2026-10-10" } as const,
        end: { kind: "date", value: "2026-10-11" } as const,
        recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
      };
      yield* f.adapter.createCalendarEvent(account, daily);
      assert.deepStrictEqual(f.writes[0]?.body, {
        summary: event.title,
        iCalUID: "travel@example.com",
        start: { date: "2026-10-10" },
        end: { date: "2026-10-11" },
        location: "Station",
        description: "ticket",
        recurrence: daily.recurrence,
      });
      assert.match(f.writes[0]?.path ?? "", /events\/import$/);
    }),
);
it.effect(
  "calendar scope failures remain independent from mail authentication; invalid/unknown times never write",
  () =>
    Effect.gen(function* () {
      const adapter = makeProviderCalendar(
        "gmail",
        () => Effect.fail(new ProviderError({ status: 403, message: "insufficient scope" })),
        () => Effect.fail(new ProviderError({ status: 403, message: "insufficient scope" })),
      );
      const read = yield* adapter.calendarEvents(account, event).pipe(Effect.result);
      assert.strictEqual(read._tag === "Failure" && read.failure._tag, "FeatureScopeMissing");
      const write = yield* adapter.createCalendarEvent(account, event).pipe(Effect.result);
      assert.strictEqual(write._tag === "Failure" && write.failure._tag, "FeatureScopeMissing");
      const f = fake("gmail", []);
      const invalid = {
        ...event,
        start: {
          kind: "zoned",
          value: "2026-10-10T09:00:00",
          zone: "Unknown",
          timestamp: null,
        } as const,
      };
      assert.strictEqual(
        (yield* f.adapter.createCalendarEvent(account, invalid).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(f.writes.length, 0);
      const repeated = fake("gmail", [{ nextPageToken: "same" }, { nextPageToken: "same" }]);
      assert.strictEqual(
        (yield* repeated.adapter.calendarEvents(account, event).pipe(Effect.result))._tag,
        "Failure",
      );
    }),
);
it.effect(
  "Outlook uses the granted calendar view and event endpoints; refuses foreign pagination and unsupported recurrence",
  () =>
    Effect.gen(function* () {
      const item = {
        id: "one",
        subject: "Busy",
        start: { dateTime: "2026-10-10T09:30:00", timeZone: "UTC" },
        end: { dateTime: "2026-10-10T10:00:00", timeZone: "UTC" },
      };
      const f = fake("outlook", [
        {
          value: [item],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=next",
        },
        { value: [{ ...item, id: "two", isAllDay: true }] },
      ]);
      assert.deepStrictEqual(
        (yield* f.adapter.calendarEvents(account, event)).map((e) => e.key),
        ["one", "two"],
      );
      assert.ok(f.reads[0]?.startsWith("/me/calendarView?"));
      yield* f.adapter.createCalendarEvent(account, event);
      assert.strictEqual(f.writes[0]?.path, "/me/events");
      assert.strictEqual(
        (yield* f.adapter
          .createCalendarEvent(account, {
            ...event,
            recurrence: ["RRULE:FREQ=DAILY", "EXDATE:20261011T090000Z"],
          })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(f.writes.length, 1);
      const unsafe = fake("outlook", [
        { value: [], "@odata.nextLink": "https://evil.example/me/calendarView" },
      ]);
      assert.strictEqual(
        (yield* unsafe.adapter.calendarEvents(account, event).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(unsafe.reads.length, 1);
    }),
);

it.effect(
  "Windows TZIDs are mapped before a Google import; unknown recurring zones never write",
  () =>
    Effect.gen(function* () {
      const f = fake("gmail", [{ items: [] }]);
      const zoned = {
        ...event,
        start: {
          kind: "zoned",
          value: "2026-10-10T09:00:00",
          zone: "Pacific Standard Time",
          timestamp: Date.parse("2026-10-10T16:00:00Z"),
        } as const,
        end: {
          kind: "zoned",
          value: "2026-10-10T10:00:00",
          zone: "Pacific Standard Time",
          timestamp: Date.parse("2026-10-10T17:00:00Z"),
        } as const,
        recurrence: ["RRULE:FREQ=WEEKLY;COUNT=2"],
      };
      yield* f.adapter.createCalendarEvent(account, zoned);
      const body = Schema.decodeUnknownSync(
        Schema.Struct({ start: Schema.Struct({ timeZone: Schema.String }) }),
      )(f.writes[0]?.body);
      assert.strictEqual(body.start.timeZone, "America/Los_Angeles");
      const unknown = { ...zoned, start: { ...zoned.start, zone: "Custom/Office" } };
      const failure = yield* f.adapter.createCalendarEvent(account, unknown).pipe(Effect.result);
      assert.strictEqual(failure._tag, "Failure");
      assert.strictEqual(f.writes.length, 1);
    }),
);

it.effect(
  "Google keeps the published iCalUID and deduplicates imports; unmappable non-recurring zones use UTC instants",
  () =>
    Effect.gen(function* () {
      const uid = "original-publish@example.com";
      const existing = fake("gmail", [{ items: [{ id: "already-imported", iCalUID: uid }] }]);
      yield* existing.adapter.createCalendarEvent(account, { ...event, uid });
      assert.strictEqual(existing.writes.length, 0);
      assert.strictEqual(new URL(existing.reads[0] ?? "").searchParams.get("iCalUID"), uid);
      const fresh = fake("gmail", []);
      const instant = Date.parse("2026-10-10T09:00:00Z");
      yield* fresh.adapter.createCalendarEvent(account, {
        ...event,
        uid,
        start: {
          kind: "zoned",
          value: "2026-10-10T09:00:00",
          zone: "Custom/Office",
          timestamp: instant,
        },
        end: {
          kind: "zoned",
          value: "2026-10-10T10:00:00",
          zone: "Custom/Office",
          timestamp: instant + 3600000,
        },
      });
      const imported = Schema.decodeUnknownSync(
        Schema.Struct({
          iCalUID: Schema.String,
          start: Schema.Struct({
            dateTime: Schema.String,
            timeZone: Schema.optionalKey(Schema.String),
          }),
        }),
      )(fresh.writes[0]?.body);
      assert.strictEqual(imported.iCalUID, uid);
      assert.ok(
        !Object.hasOwn(
          Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
            fresh.writes[0]?.body,
          ),
          "id",
        ),
      );
      assert.deepStrictEqual(imported.start, { dateTime: "2026-10-10T09:00:00.000Z" });
    }),
);

it.effect(
  "rapid re-imports of one UID are serialized even while the remote UID index is stale",
  () =>
    Effect.gen(function* () {
      const f = fake("gmail", []),
        published = { ...event, uid: "unique-publish@example.com" };
      yield* Effect.all(
        [
          f.adapter.createCalendarEvent(account, published),
          f.adapter.createCalendarEvent(account, published),
        ],
        { concurrency: "unbounded" },
      );
      yield* f.adapter.createCalendarEvent(account, published);
      assert.strictEqual(f.writes.length, 1);
      yield* f.adapter.createCalendarEvent({ ...account, id: "gmail:other@gmail.com" }, published);
      assert.strictEqual(f.writes.length, 2);
    }),
);

it.effect(
  "Outlook imports carry a stable transactionId and deduplicate rapid and repeated confirmation",
  () =>
    Effect.gen(function* () {
      const f = fake("outlook", []),
        published = { ...event, uid: "outlook-publish@example.com" };
      yield* Effect.all(
        [
          f.adapter.createCalendarEvent(account, published),
          f.adapter.createCalendarEvent(account, published),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(f.writes.length, 1);
      const transaction = Schema.decodeUnknownSync(Schema.Struct({ transactionId: Schema.String }))(
        f.writes[0]?.body,
      ).transactionId;
      assert.match(transaction, /^[0-9a-f]{64}$/);
      const reopened = fake("outlook", []);
      yield* reopened.adapter.createCalendarEvent(account, published);
      assert.strictEqual(
        Schema.decodeUnknownSync(Schema.Struct({ transactionId: Schema.String }))(
          reopened.writes[0]?.body,
        ).transactionId,
        transaction,
      );
    }),
);

it.effect("Graph calendar pagination accepts calendar key segments unchanged", () =>
  Effect.gen(function* () {
    const next =
      "https://graph.microsoft.com/v1.0/me/calendars('default')/calendarView?$skiptoken=a%2Fb";
    const f = fake("outlook", [{ value: [], "@odata.nextLink": next }, { value: [] }]);
    yield* f.adapter.calendarEvents(account, event);
    assert.strictEqual(f.reads[1], next);
  }),
);
