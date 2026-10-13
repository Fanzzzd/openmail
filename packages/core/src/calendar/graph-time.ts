import { WINDOWS_ZONES } from "./windows-zones.js";

/** Graph schedules carry a wall-clock time and an IANA or Windows zone. */
export function graphTimestamp(value: {
  readonly dateTime: string;
  readonly timeZone: string;
}): number {
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(value.dateTime)) {
    const timestamp = Date.parse(value.dateTime);
    if (!Number.isFinite(timestamp)) throw new RangeError("Invalid automatic reply date");
    return timestamp;
  }
  const wall = Date.parse(`${value.dateTime}Z`);
  if (!Number.isFinite(wall)) throw new RangeError("Invalid automatic reply date");
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: WINDOWS_ZONES[value.timeZone] ?? value.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const parts = new Map(format.formatToParts(guess).map((p) => [p.type, p.value]));
    const observed =
      Date.UTC(
        Number(parts.get("year")),
        Number(parts.get("month")) - 1,
        Number(parts.get("day")),
        Number(parts.get("hour")),
        Number(parts.get("minute")),
        Number(parts.get("second")),
      ) +
      (guess % 1000);
    const correction = wall - observed;
    if (!correction) return guess;
    guess += correction;
  }
  throw new RangeError("Automatic reply date does not exist in this time zone");
}
