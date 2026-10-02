import { sha256Hex } from "./platform/crypto.js";
import { WINDOWS_ZONES } from "./windows-zones.js";
import { Effect, Schema, Result, Semaphore } from "effect";
import type { Account } from "./domain.js";
import {
  calendarTimestamp,
  calendarWindow,
  type CalendarEvent,
  type CalendarTime,
} from "./calendar.js";
import { InvalidInput } from "./errors.js";
import { featureRequest } from "./provider-features.js";
import { graphTimestamp } from "./graph-time.js";
import { graphRecurrence } from "./graph-recurrence.js";

const GoogleTime = Schema.Struct({
  date: Schema.optionalKey(Schema.String),
  dateTime: Schema.optionalKey(Schema.String),
  timeZone: Schema.optionalKey(Schema.String),
});
const GoogleEvent = Schema.Struct({
  id: Schema.String,
  iCalUID: Schema.optionalKey(Schema.String),
  summary: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.String),
  transparency: Schema.optionalKey(Schema.String),
  start: Schema.optionalKey(GoogleTime),
  end: Schema.optionalKey(GoogleTime),
  location: Schema.optionalKey(Schema.String),
});
const GooglePage = Schema.Struct({
  items: Schema.optionalKey(Schema.Array(GoogleEvent)),
  nextPageToken: Schema.optionalKey(Schema.String),
});
const GraphTime = Schema.Struct({ dateTime: Schema.String, timeZone: Schema.String });
const GraphEvent = Schema.Struct({
  id: Schema.String,
  iCalUId: Schema.optionalKey(Schema.String),
  subject: Schema.optionalKey(Schema.String),
  isCancelled: Schema.optionalKey(Schema.Boolean),
  isAllDay: Schema.optionalKey(Schema.Boolean),
  showAs: Schema.optionalKey(Schema.String),
  start: GraphTime,
  end: GraphTime,
});
const GraphPage = Schema.Struct({
  value: Schema.Array(GraphEvent),
  "@odata.nextLink": Schema.optionalKey(Schema.String),
});
const GOOGLE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function googleTime(time: typeof GoogleTime.Type | undefined): CalendarTime | null {
  if (time?.date) return { kind: "date", value: time.date };
  if (!time?.dateTime) return null;
  const stamp = Date.parse(time.dateTime);
  return Number.isFinite(stamp)
    ? { kind: "zoned", value: time.dateTime, zone: time.timeZone ?? "UTC", timestamp: stamp }
    : null;
}
const GOOGLE_ZONES = new Set(Intl.supportedValuesOf("timeZone"));
function googleZone(zone: string): string | undefined {
  const mapped = WINDOWS_ZONES[zone] ?? zone;
  if (GOOGLE_ZONES.has(mapped)) return mapped;
  const canonical = Result.getOrElse(
    Result.try(
      () => new Intl.DateTimeFormat("en", { timeZone: mapped }).resolvedOptions().timeZone,
    ),
    () => "",
  );
  return GOOGLE_ZONES.has(canonical) ? canonical : undefined;
}
function googleInput(time: CalendarTime, recurring: boolean) {
  if (time.kind === "date") return { date: time.value };
  const zone = googleZone(
    time.kind === "floating" ? Intl.DateTimeFormat().resolvedOptions().timeZone : time.zone,
  );
  if (recurring && !zone)
    throw new InvalidInput({
      message: "This recurring event has a time zone Google Calendar cannot use",
    });
  const timestamp = calendarTimestamp(time);
  if (!Number.isFinite(timestamp)) throw new RangeError("Invalid calendar event time");
  return { dateTime: new Date(timestamp).toISOString(), ...(zone ? { timeZone: zone } : {}) };
}
function graphInput(time: CalendarTime) {
  if (time.kind === "zoned" && time.timestamp !== null)
    return { dateTime: new Date(time.timestamp).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
  return {
    dateTime: time.kind === "date" ? `${time.value}T00:00:00` : time.value,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Existing grants only; provider failures retain the calendar-specific scope error. */
export function makeProviderCalendar<
  E extends {
    readonly _tag: string;
    readonly status?: number;
    readonly body?: string;
    readonly message?: string;
  },
>(
  provider: "gmail" | "outlook",
  get: <A>(id: string, schema: Schema.Decoder<A>, path: string) => Effect.Effect<A, E>,
  post: (id: string, path: string, body: unknown) => Effect.Effect<unknown, E>,
) {
  const creationLock = Semaphore.makeUnsafe(1);
  const imported = new Set<string>();
  return {
    calendarEvents: (account: Account, event: CalendarEvent) =>
      featureRequest(
        account,
        "calendar",
        Effect.gen(function* () {
          const window = yield* Effect.try({
            try: () => calendarWindow(event),
            catch: () => new InvalidInput({ message: "Invalid calendar event time" }),
          });
          const events: CalendarEvent[] = [];
          const seen = new Set<string>();
          if (provider === "gmail") {
            let token = "";
            do {
              const query = new URLSearchParams({
                ...window,
                singleEvents: "true",
                orderBy: "startTime",
                ...(googleZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
                  ? { timeZone: googleZone(Intl.DateTimeFormat().resolvedOptions().timeZone) }
                  : {}),
                ...(token ? { pageToken: token } : {}),
              });
              const page = yield* get(account.id, GooglePage, `${GOOGLE}?${query.toString()}`);
              for (const item of page.items ?? []) {
                const start = googleTime(item.start),
                  end = googleTime(item.end);
                if (
                  start &&
                  end &&
                  item.status !== "cancelled" &&
                  item.transparency !== "transparent" &&
                  item.iCalUID !== event.key
                )
                  events.push({
                    key: item.id,
                    title: item.summary ?? "",
                    start,
                    end,
                    location: item.location ?? "",
                    description: "",
                    recurrence: [],
                  });
              }
              token = page.nextPageToken ?? "";
              if (token && seen.has(token))
                return yield* new InvalidInput({ message: "Calendar pagination repeated a page" });
              seen.add(token);
            } while (token);
          } else {
            let path = `/me/calendarView?${new URLSearchParams({ startDateTime: window.timeMin, endDateTime: window.timeMax, $top: "250" }).toString()}`;
            while (path) {
              if (seen.has(path))
                return yield* new InvalidInput({ message: "Calendar pagination repeated a page" });
              seen.add(path);
              const page = yield* get(account.id, GraphPage, path);
              for (const item of page.value) {
                if (item.isCancelled || item.showAs === "free" || item.iCalUId === event.key)
                  continue;
                const start: CalendarTime = item.isAllDay
                  ? { kind: "date", value: item.start.dateTime.slice(0, 10) }
                  : {
                      kind: "zoned",
                      value: item.start.dateTime,
                      zone: item.start.timeZone,
                      timestamp: Result.getOrElse(
                        Result.try(() => graphTimestamp(item.start)),
                        () => null,
                      ),
                    };
                const end: CalendarTime = item.isAllDay
                  ? { kind: "date", value: item.end.dateTime.slice(0, 10) }
                  : {
                      kind: "zoned",
                      value: item.end.dateTime,
                      zone: item.end.timeZone,
                      timestamp: Result.getOrElse(
                        Result.try(() => graphTimestamp(item.end)),
                        () => null,
                      ),
                    };
                events.push({
                  key: item.id,
                  title: item.subject ?? "",
                  start,
                  end,
                  location: "",
                  description: "",
                  recurrence: [],
                });
              }
              const next = page["@odata.nextLink"];
              if (!next) break;
              const url = new URL(next);
              if (
                url.origin !== "https://graph.microsoft.com" ||
                url.pathname !== "/v1.0/me/calendarView"
              )
                return yield* new InvalidInput({ message: "Invalid calendar pagination link" });
              path = `${url.pathname.slice(5)}${url.search}`;
            }
          }
          return events;
        }),
      ),
    createCalendarEvent: (account: Account, event: CalendarEvent) =>
      creationLock.withPermit(
        featureRequest(
          account,
          "calendar",
          Effect.gen(function* () {
            yield* Effect.try({
              try: () => calendarWindow(event),
              catch: () => new InvalidInput({ message: "Invalid calendar event time" }),
            });
            const uid =
              event.uid ?? `openmail-${sha256Hex(`${account.id}:${event.key}`)}@openmail.local`;
            const identity = sha256Hex(JSON.stringify([account.id, uid]));
            const body = yield* Effect.try({
              try: () =>
                provider === "gmail"
                  ? {
                      summary: event.title,
                      iCalUID: uid,
                      start: googleInput(event.start, event.recurrence.length > 0),
                      end: googleInput(event.end, event.recurrence.length > 0),
                      location: event.location,
                      description: event.description,
                      ...(event.recurrence.length ? { recurrence: event.recurrence } : {}),
                    }
                  : {
                      subject: event.title,
                      transactionId: identity,
                      ...(event.recurrence.length
                        ? graphRecurrence(event)
                        : { start: graphInput(event.start), end: graphInput(event.end) }),
                      isAllDay: event.start.kind === "date",
                      location: { displayName: event.location },
                      body: { contentType: "text", content: event.description },
                    },
              catch: (error) =>
                error instanceof InvalidInput
                  ? error
                  : new InvalidInput({ message: "Invalid calendar event time" }),
            });
            if (imported.has(identity)) return yield* Effect.void;
            if (provider === "gmail") {
              let token = "";
              const seen = new Set<string>();
              do {
                const query = new URLSearchParams({
                  iCalUID: uid,
                  ...(token ? { pageToken: token } : {}),
                });
                const page = yield* get(account.id, GooglePage, `${GOOGLE}?${query.toString()}`);
                if (page.items?.some((item) => item.status !== "cancelled"))
                  return yield* Effect.void;
                token = page.nextPageToken ?? "";
                if (token && seen.has(token))
                  return yield* new InvalidInput({
                    message: "Calendar pagination repeated a page",
                  });
                seen.add(token);
              } while (token);
            }
            yield* post(account.id, provider === "gmail" ? `${GOOGLE}/import` : "/me/events", body);
            imported.add(identity);
            if (imported.size > 256) {
              const oldest = imported.values().next().value;
              if (oldest) imported.delete(oldest);
            }
            return yield* Effect.void;
          }),
        ),
      ),
  };
}
