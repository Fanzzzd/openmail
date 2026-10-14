/** Tools for calendar invites in a message and the events they overlap. */

import {
  MailToolError,
  MessageId,
  ToolCalendarTime,
  mailTool,
  page,
  readOnly,
  toToolError,
  toolCalendarTime,
} from "./tool-common.js";
import { Effect, Schema } from "effect";
import { PageParameters, PageResult, shortText } from "./tool-pages.js";
import { CalendarEvent, CalendarInvite } from "../calendar/calendar.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";

export const ListInvites = readOnly(
  mailTool("list_invites", {
    description:
      "Read the calendar invitations in a message. May fetch the original message from its provider. Pass each key with the same message_id to calendar_overlap; page with next_cursor. A zoned time keeps the sender's wall time and zone; its timestamp is local.",
    times: true,
    parameters: Schema.Struct({ message_id: MessageId, ...PageParameters }),
    success: Schema.Struct({
      ...PageResult,
      invites: Schema.Array(
        Schema.Struct({
          ...CalendarInvite.fields,
          start: Schema.NullOr(ToolCalendarTime),
          end: Schema.NullOr(ToolCalendarTime),
          recurrenceId: Schema.NullOr(ToolCalendarTime),
        }),
      ),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
  true,
);
export const CalendarOverlap = readOnly(
  mailTool("calendar_overlap", {
    description:
      "List calendar events that overlap an invitation. Not available for IMAP accounts or accounts without calendar access. Page with next_cursor.",
    times: true,
    parameters: Schema.Struct({
      message_id: MessageId,
      key: Schema.String.annotate({ description: "An invite key from list_invites." }),
      ...PageParameters,
    }),
    success: Schema.Struct({
      ...PageResult,
      events: Schema.Array(
        Schema.Struct({ ...CalendarEvent.fields, start: ToolCalendarTime, end: ToolCalendarTime }),
      ),
    }),
    failure: MailToolError,
    failureMode: "return",
  }),
  true,
);

export const calendarHandlers = ({ mailbox, requireMessage, timeZone }: ToolContext) => {
  const local = (time: Parameters<typeof toolCalendarTime>[0] | null) =>
    time === null ? null : toolCalendarTime(time, timeZone());
  return {
    list_invites: (p) =>
      page(
        "list_invites",
        p,
        Effect.andThen(
          requireMessage(p.message_id),
          mailbox.calendar.invitations(p.message_id).pipe(Effect.mapError(toToolError)),
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              ...r,
              start: local(r.start),
              end: local(r.end),
              recurrenceId: local(r.recurrenceId),
              title: shortText(r.title),
              location: shortText(r.location),
              description: "",
              attendees: r.attendees.slice(0, 20).map((a) => ({ ...a, name: shortText(a.name) })),
              recurrence: r.recurrence.slice(0, 10),
            })),
          ),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, invites: items }))),
    calendar_overlap: (p) =>
      page(
        "calendar_overlap",
        p,
        Effect.andThen(
          requireMessage(p.message_id),
          mailbox.calendar.calendarEvents(p.message_id, p.key).pipe(Effect.mapError(toToolError)),
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              ...r,
              start: toolCalendarTime(r.start, timeZone()),
              end: toolCalendarTime(r.end, timeZone()),
              title: shortText(r.title),
              location: shortText(r.location),
              description: "",
              recurrence: r.recurrence.slice(0, 10),
            })),
          ),
        ),
      ).pipe(Effect.map(({ items, ...rest }) => ({ ...rest, events: items }))),
  } satisfies HandlersFor<typeof ListInvites | typeof CalendarOverlap>;
};
