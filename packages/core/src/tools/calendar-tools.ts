/** Tools for calendar invites in a message and the events they overlap. */

import { MailToolError, MessageId, mailTool, page, readOnly, toToolError } from "./tool-common.js";
import { Effect, Schema } from "effect";
import { PageParameters, PageResult, shortText } from "./tool-pages.js";
import { CalendarEvent, CalendarInvite } from "../calendar/calendar.js";
import type { HandlersFor, ToolContext } from "./tool-context.js";

export const ListInvites = readOnly(
  mailTool("list_invites", {
    description:
      "Read the calendar invitations in a message. May fetch the original message from its provider. Pass each key with the same message_id to calendar_overlap; page with next_cursor.",
    parameters: Schema.Struct({ message_id: MessageId, ...PageParameters }),
    success: Schema.Struct({ ...PageResult, invites: Schema.Array(CalendarInvite) }),
    failure: MailToolError,
    failureMode: "return",
  }),
  true,
);
export const CalendarOverlap = readOnly(
  mailTool("calendar_overlap", {
    description:
      "List calendar events that overlap an invitation. Not available for IMAP accounts or accounts without calendar access. Page with next_cursor.",
    parameters: Schema.Struct({
      message_id: MessageId,
      key: Schema.String.annotate({ description: "An invite key from list_invites." }),
      ...PageParameters,
    }),
    success: Schema.Struct({ ...PageResult, events: Schema.Array(CalendarEvent) }),
    failure: MailToolError,
    failureMode: "return",
  }),
  true,
);

export const calendarHandlers = ({ mailbox, requireMessage }: ToolContext) => {
  return {
    list_invites: (p) =>
      page(
        "list_invites",
        p,
        Effect.andThen(
          requireMessage(p.message_id),
          mailbox.invitations(p.message_id).pipe(Effect.mapError(toToolError)),
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              ...r,
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
          mailbox.calendarEvents(p.message_id, p.key).pipe(Effect.mapError(toToolError)),
        ).pipe(
          Effect.map((rows) =>
            rows.map((r) => ({
              ...r,
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
