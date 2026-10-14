import {
  CalendarInvite,
  CalendarEvent,
  CalendarEventEdits,
  InviteResponse,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Calendar events and invitations found in messages. */
export const CalendarRpcs = [
  Rpc.make("CalendarEvents", {
    payload: { messageId: Schema.String, key: Schema.String },
    success: Schema.Array(CalendarEvent),
    error,
  }),
  Rpc.make("DetectedEvents", {
    payload: { messageId: Schema.String },
    success: Schema.Array(CalendarEvent),
    error,
  }),
  Rpc.make("CreateCalendarEvent", {
    payload: {
      messageId: Schema.String,
      key: Schema.String,
      edits: Schema.optionalKey(CalendarEventEdits),
    },
    error,
  }),
  Rpc.make("Invitations", {
    payload: { messageId: Schema.String },
    success: Schema.Array(CalendarInvite),
    error,
  }),
  /** User click only. No MCP write tool maps to this endpoint. */
  Rpc.make("RespondInvite", {
    payload: {
      messageId: Schema.String,
      key: Schema.String,
      response: InviteResponse,
      /** The response in the app language, for the subject of an IMAP reply. */
      label: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
    },
    error,
  }),
] as const;
