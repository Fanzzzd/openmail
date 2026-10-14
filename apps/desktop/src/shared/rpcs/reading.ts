import { BatchResult, Label, Message, ThreadQuery, ThreadSummary } from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { AccountIds, error } from "./fields";

/** Header labels for printing, in the UI language. */
export const PrintHeadings = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  cc: Schema.String,
  date: Schema.String,
});

const Counts = Schema.Record(Schema.String, Schema.Number);

/** Threads, messages, printing, message windows and unread counts. */
export const ReadingRpcs = [
  Rpc.make("Threads", {
    payload: { query: ThreadQuery },
    success: Schema.Array(ThreadSummary),
    error,
  }),
  Rpc.make("Thread", { payload: { id: Schema.String }, success: Schema.Array(Message), error }),
  /** The message's original source from the provider (View Original). */
  Rpc.make("RawMessage", { payload: { id: Schema.String }, success: Schema.String, error }),
  Rpc.make("SaveMessage", { payload: { id: Schema.String }, success: Schema.Boolean, error }),
  Rpc.make("OpenMessageWeb", { payload: { id: Schema.String }, error }),
  Rpc.make("KnownSenders", {
    payload: { accountId: Schema.String, addresses: Schema.Array(Schema.String) },
    success: Schema.Array(Schema.String),
  }),
  Rpc.make("SearchSender", { payload: { address: Schema.String } }),
  /** Inline (cid:) images of a message as data: URLs by Content-ID. */
  Rpc.make("InlineImages", {
    payload: { id: Schema.String },
    success: Schema.Record(Schema.String, Schema.String),
    error,
  }),
  Rpc.make("ImageSenders", { success: Schema.Array(Schema.String) }),
  /** Adds or removes an address or a domain on the remote image allowlist. */
  Rpc.make("SetImageSender", { payload: { entry: Schema.String, allowed: Schema.Boolean } }),
  /**
   * Prints the thread of `id`, or only message `only`, from a hidden window.
   * With `pdf` it asks where to save and writes a PDF instead. False when
   * the person cancelled.
   */
  Rpc.make("PrintThread", {
    payload: {
      id: Schema.String,
      only: Schema.optionalKey(Schema.String),
      pdf: Schema.Boolean,
      headings: PrintHeadings,
      locale: Schema.String,
    },
    success: Schema.Boolean,
    error,
  }),
  /** Opens the thread of `id` in a window of its own. */
  Rpc.make("OpenThreadWindow", { payload: { id: Schema.String } }),
  Rpc.make("OpenMessageWindow", { payload: { id: Schema.String } }),
  Rpc.make("OpenMeeting", { payload: { url: Schema.String }, error }),
  Rpc.make("MarkUnreadFrom", { payload: { id: Schema.String }, success: BatchResult, error }),
  Rpc.make("Labels", { payload: { accountIds: AccountIds }, success: Schema.Array(Label) }),
  Rpc.make("UnreadCounts", { success: Counts }),
  Rpc.make("UnreadByLabel", {
    payload: {
      accountIds: AccountIds,
      within: Schema.optionalKey(Schema.String),
      conversations: Schema.optionalKey(Schema.Boolean),
    },
    success: Counts,
  }),
] as const;
