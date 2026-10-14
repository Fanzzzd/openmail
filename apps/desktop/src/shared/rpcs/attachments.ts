import {
  AttachmentInspection,
  AttachmentPath,
  ReaderAttachment,
  EmbeddedMessage,
  AttachmentAction,
  AttachmentActionResult,
} from "@openmail/core/schema";
import { AttachmentApp, DownloadCommand, DownloadItem } from "../downloads";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Attachments and downloads. */
export const AttachmentRpcs = [
  Rpc.make("AttachmentCapabilities", { success: Schema.Struct({ share: Schema.Boolean }) }),
  Rpc.make("ImportCalendarAttachment", {
    payload: { messageId: Schema.String, path: AttachmentPath, key: Schema.String },
    error,
  }),
  Rpc.make("InspectAttachment", {
    payload: { messageId: Schema.String, path: AttachmentPath },
    success: AttachmentInspection,
    error,
  }),
  Rpc.make("ReaderAttachments", {
    payload: { messageId: Schema.String },
    success: Schema.Array(ReaderAttachment),
    error,
  }),
  Rpc.make("EmbeddedMessage", {
    payload: { messageId: Schema.String, path: AttachmentPath },
    success: EmbeddedMessage,
    error,
  }),
  Rpc.make("ReleaseAttachmentDrag", {
    payload: { messageId: Schema.String, listId: Schema.String.check(Schema.isMaxLength(256)) },
    error,
  }),
  Rpc.make("PrepareAttachmentDrag", {
    payload: {
      listId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
      messageId: Schema.String,
      paths: Schema.Array(AttachmentPath).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    },
    error,
  }),
  Rpc.make("AttachmentAction", {
    payload: {
      listId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
      messageId: Schema.String,
      paths: Schema.Array(AttachmentPath).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      action: AttachmentAction,
      /** For openWith: one of the apps AttachmentApps returned. */
      application: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
    },
    success: AttachmentActionResult,
    error,
  }),
  /** Downloads to a folder the person picks in the OS folder picker. 0 when cancelled. */
  Rpc.make("SaveAttachmentsTo", {
    payload: {
      messageId: Schema.String,
      paths: Schema.Array(AttachmentPath).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    },
    success: Schema.Int,
    error,
  }),
  /** Apps registered for one attachment, for the Open With menu. */
  Rpc.make("AttachmentApps", {
    payload: { messageId: Schema.String, path: AttachmentPath },
    success: Schema.Array(AttachmentApp),
    error,
  }),
  /** The current downloads, then the list again after every change. */
  Rpc.make("Downloads", { success: Schema.Array(DownloadItem), stream: true }),
  Rpc.make("DownloadAction", {
    payload: { id: Schema.String, command: DownloadCommand },
    error,
  }),
  /** Removes finished and failed downloads from the list. Files stay on disk. */
  Rpc.make("ClearDownloads"),
] as const;
