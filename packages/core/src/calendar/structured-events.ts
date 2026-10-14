import { parseDocument } from "htmlparser2";
import { Option, Schema } from "effect";
import type { CalendarTime } from "./calendar-time.js";
import { calendarTimestamp } from "./event-dates.js";
import type { CalendarEvent } from "./calendar-event.js";

const Item = Schema.Struct({
  "@type": Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  "@graph": Schema.optionalKey(Schema.Array(Schema.Unknown)),
  reservationFor: Schema.optionalKey(Schema.Unknown),
  subReservation: Schema.optionalKey(Schema.Unknown),
  reservationStatus: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  flightNumber: Schema.optionalKey(Schema.String),
  trainNumber: Schema.optionalKey(Schema.String),
  startTime: Schema.optionalKey(Schema.String),
  endTime: Schema.optionalKey(Schema.String),
  startDate: Schema.optionalKey(Schema.String),
  endDate: Schema.optionalKey(Schema.String),
  departureTime: Schema.optionalKey(Schema.String),
  arrivalTime: Schema.optionalKey(Schema.String),
  checkinTime: Schema.optionalKey(Schema.String),
  checkoutTime: Schema.optionalKey(Schema.String),
  location: Schema.optionalKey(Schema.Unknown),
  departureAirport: Schema.optionalKey(Schema.Unknown),
  departureStation: Schema.optionalKey(Schema.Unknown),
  arrivalAirport: Schema.optionalKey(Schema.Unknown),
  arrivalStation: Schema.optionalKey(Schema.Unknown),
  address: Schema.optionalKey(Schema.Unknown),
  streetAddress: Schema.optionalKey(Schema.String),
  addressLocality: Schema.optionalKey(Schema.String),
});
type Item = typeof Item.Type;
const decode = (value: unknown): Item | null =>
  Option.getOrNull(Schema.decodeUnknownOption(Item)(value));
const text = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 2000);
  const item = decode(value);
  return item
    ? (item.name ?? [item.streetAddress, item.addressLocality].filter(Boolean).join(", "))
    : "";
};
const typeName = (type: string) => type.replace(/^https?:\/\/schema.org\//, "");
function time(value: string | undefined): CalendarTime | null {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)
  )
    return null;
  const date = value.slice(0, 10);
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)
    return null;
  if (value.length === 10) return { kind: "date", value };
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return null;
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? { kind: "zoned", value: new Date(timestamp).toISOString(), zone: "UTC", timestamp }
      : null;
  }
  return { kind: "floating", value };
}

function defaultEnd(start: CalendarTime, hours: number): CalendarTime {
  if (start.kind === "date") {
    const day = new Date(`${start.value}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1);
    return { kind: "date", value: day.toISOString().slice(0, 10) };
  }
  if (start.kind === "floating") {
    const wall = new Date(`${start.value}Z`);
    wall.setUTCHours(wall.getUTCHours() + hours);
    return { kind: "floating", value: wall.toISOString().slice(0, 19) };
  }
  // Only a zoned start reaches here, so the zone argument is unused.
  const timestamp = calendarTimestamp(start, "UTC") + hours * 3600000;
  return { kind: "zoned", value: new Date(timestamp).toISOString(), zone: "UTC", timestamp };
}

/** Bounded, inert parsing. JSON-LD contexts, itemref URLs, images and links are never fetched. */
export function structuredMailEvents(
  html: string,
  subject: string,
): { events: CalendarEvent[]; cancelled: boolean } {
  if (!html || html.length > 1_000_000) return { events: [], cancelled: false };
  const result: CalendarEvent[] = [];
  let cancelled = false;
  let budget = 5000;
  const consume = (raw: unknown, depth = 0): void => {
    if (--budget < 0 || depth > 32 || result.length >= 20) return;
    if (Array.isArray(raw)) {
      for (const value of raw) consume(value, depth + 1);
      return;
    }
    const item = decode(raw);
    if (!item) return;
    const types = (typeof item["@type"] === "string" ? [item["@type"]] : (item["@type"] ?? [])).map(
      typeName,
    );
    const supported = types.some((t) =>
      [
        "FlightReservation",
        "TrainReservation",
        "LodgingReservation",
        "FoodEstablishmentReservation",
        "RestaurantReservation",
        "EventReservation",
        "Reservation",
        "Flight",
        "TrainTrip",
        "Event",
      ].includes(t),
    );
    if (supported) {
      if (item.reservationStatus?.endsWith("ReservationCancelled")) {
        cancelled = true;
        return;
      }
    }
    if (item["@graph"]) consume(item["@graph"], depth + 1);
    if (item.subReservation) consume(item.subReservation, depth + 1);
    if (!supported) return;
    const target = decode(item.reservationFor) ?? item;
    const start = time(
      target.departureTime ??
        item.checkinTime ??
        item.startTime ??
        item.startDate ??
        target.startTime ??
        target.startDate,
    );
    const endValue =
      target.arrivalTime ??
      item.checkoutTime ??
      item.endTime ??
      item.endDate ??
      target.endTime ??
      target.endDate;
    let end = time(endValue);
    if (start && !endValue)
      end = defaultEnd(
        start,
        types.some((t) => ["FoodEstablishmentReservation", "RestaurantReservation"].includes(t))
          ? 2
          : 1,
      );
    // schema.org endDate names the final calendar day. Lodging checkoutTime
    // already names the exclusive checkout day and must remain unchanged.
    if (
      end?.kind === "date" &&
      !target.arrivalTime &&
      !item.checkoutTime &&
      (item.endDate || target.endDate)
    )
      end = defaultEnd(end, 1);
    // Start and end share a kind, so comparing their wall times in UTC orders them exactly.
    if (
      !start ||
      !end ||
      start.kind !== end.kind ||
      !Number.isFinite(calendarTimestamp(start, "UTC")) ||
      !Number.isFinite(calendarTimestamp(end, "UTC")) ||
      calendarTimestamp(end, "UTC") <= calendarTimestamp(start, "UTC")
    )
      return;
    const departure = text(target.departureAirport ?? target.departureStation);
    const arrival = text(target.arrivalAirport ?? target.arrivalStation);
    const location = departure
      ? [departure, arrival].filter(Boolean).join(" → ")
      : text(item.location ?? target.location ?? target.address) || text(target);
    const event: CalendarEvent = {
      key: "",
      ...(!endValue ? { endEstimated: true } : {}),
      title: target.name ?? item.name ?? target.flightNumber ?? target.trainNumber ?? subject,
      start,
      end,
      location,
      description: item.description ?? target.description ?? "",
      recurrence: [],
    };
    const key = `structured:${JSON.stringify(event)}`;
    if (!result.some((e) => e.key === key)) result.push({ ...event, key });
  };
  const document = parseDocument(html);
  type Node = (typeof document.children)[number];
  const content = (node: Node): string => {
    const pending = [node];
    let collected = "";
    while (pending.length && collected.length < 100_000 && --budget >= 0) {
      const current = pending.pop();
      if (!current) break;
      if ("data" in current) collected += current.data;
      else if ("children" in current)
        for (const child of current.children.toReversed()) pending.push(child);
    }
    return collected.slice(0, 100_000);
  };
  const micro = (node: Node, depth = 0): Record<string, unknown> => {
    if (depth > 32 || --budget < 0 || !("attribs" in node)) return {};
    const item: Record<string, unknown> = {
      "@type": node.attribs.itemtype?.split(/\s+/).map(typeName) ?? [],
    };
    const visit = (child: Node, childDepth = 0): void => {
      if (--budget < 0 || childDepth > 64 || !("attribs" in child)) return;
      const props = child.attribs.itemprop?.split(/\s+/) ?? [];
      const scoped = child.attribs.itemscope !== undefined;
      const value = scoped
        ? micro(child, depth + 1)
        : (child.attribs.content ?? child.attribs.datetime ?? child.attribs.href ?? content(child));
      for (const prop of props) item[prop] = value;
      if (!scoped) for (const nested of child.children) visit(nested, childDepth + 1);
    };
    for (const child of node.children) visit(child);
    return item;
  };
  const visit = (node: Node, depth = 0): void => {
    if (--budget < 0 || depth > 64) return;
    if ("attribs" in node) {
      if (
        node.name === "script" &&
        node.attribs.type?.trim().toLowerCase() === "application/ld+json"
      ) {
        try {
          consume(JSON.parse(content(node)));
        } catch {
          /* Invalid sender data is ignored. */
        }
      }
      if (node.attribs.itemscope !== undefined) {
        consume(micro(node));
        return;
      }
    }
    if ("children" in node) for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of document.children) visit(node);
  return { events: result, cancelled };
}
