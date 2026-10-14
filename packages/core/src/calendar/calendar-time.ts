import { Schema } from "effect";

/** Preserve wall time when a sender uses an unknown zone; never guess UTC. */
export const CalendarTime = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("date"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("floating"), value: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("zoned"),
    value: Schema.String,
    zone: Schema.String,
    timestamp: Schema.NullOr(Schema.Number),
  }),
]);
export type CalendarTime = typeof CalendarTime.Type;
