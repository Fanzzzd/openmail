import { Schema } from "effect";
import { CalendarTime } from "./calendar-time.js";

export const CalendarEvent = Schema.Struct({
  key: Schema.String,
  uid: Schema.optionalKey(Schema.String),
  title: Schema.String,
  start: CalendarTime,
  end: CalendarTime,
  location: Schema.String,
  description: Schema.String,
  recurrence: Schema.Array(Schema.String),
  endEstimated: Schema.optionalKey(Schema.Boolean),
  dateInput: Schema.optionalKey(Schema.String),
  hasRecurrenceOverrides: Schema.optionalKey(Schema.Boolean),
});
export type CalendarEvent = typeof CalendarEvent.Type;
