import { DockFileReason } from "./dock-files";
import { NativeAction } from "./native-actions";
import { MailtoDraft, OutgoingAttachment } from "@openmail/core/schema";
import { Schema } from "effect";

/** Open a reply or forward of message `id`; the RPC payload and the desktop event share it. */
export const ComposeMessageFields = {
  id: Schema.String,
  mode: Schema.Literals(["reply", "replyAll", "forward"]),
  asAttachment: Schema.Boolean,
};

/**
 * An undo toast for the main window, from a window that closes after the action: a thread
 * window that archived its thread, or a compose window whose draft was discarded.
 */
export const UndoNoticeFields = {
  text: Schema.String.check(Schema.isMaxLength(500)),
  undo: Schema.Union([
    Schema.TaggedStruct("Batch", {
      undoId: Schema.String,
      ids: Schema.Array(Schema.String),
    }),
    Schema.TaggedStruct("Draft", { id: Schema.String }),
  ]),
};

export const DesktopEvent = Schema.Union([
  Schema.TaggedStruct("ShowUndo", UndoNoticeFields),
  Schema.TaggedStruct("ComposeMessage", ComposeMessageFields),
  Schema.TaggedStruct("NativeAction", {
    action: NativeAction,
    triggeredByAccelerator: Schema.Boolean,
  }),
  Schema.TaggedStruct("ComposeFiles", { attachments: Schema.Array(OutgoingAttachment) }),
  Schema.TaggedStruct("FileError", { reason: DockFileReason }),
  /** A link, notification or tray item whose message could not be shown. */
  Schema.TaggedStruct("LinkError", { reason: Schema.Literals(["missing", "failed"]) }),
  Schema.TaggedStruct("UndoSend", {}),
  Schema.TaggedStruct("AttachFiles", {}),
  Schema.TaggedStruct("QuitCheck", {}),
  Schema.TaggedStruct("ComposeClose", {}),
  Schema.TaggedStruct("PopOutDraft", { id: Schema.String }),
  Schema.TaggedStruct("Edit", { action: Schema.Literals(["undo", "selectAll"]) }),
  /** Show a screen in the main window; an href from shared/routes, checked again by the renderer. */
  Schema.TaggedStruct("Navigate", { href: Schema.String }),
  Schema.TaggedStruct("Compose", { draft: MailtoDraft }),
  Schema.TaggedStruct("Search", { query: Schema.String }),
  Schema.TaggedStruct("Command", {
    command: Schema.Literals(["settings", "help", "compose", "inbox", "feedback"]),
  }),
]);
export type DesktopEvent = typeof DesktopEvent.Type;

/** Only links survive a busy editor; menu commands always act immediately or are dropped. */
export function desktopEventRoute(
  event: DesktopEvent,
  busy: boolean,
): "dispatch" | "defer" | "drop" {
  if (
    event._tag === "AttachFiles" ||
    event._tag === "ComposeClose" ||
    event._tag === "PopOutDraft" ||
    event._tag === "Edit" ||
    event._tag === "UndoSend" ||
    event._tag === "ShowUndo" ||
    event._tag === "QuitCheck"
  )
    return "dispatch";
  return event._tag === "Command" || event._tag === "NativeAction"
    ? busy
      ? "drop"
      : "dispatch"
    : "defer";
}

export const editCommandRoute = (busy: boolean, typing: boolean, readerText = false) =>
  busy || typing || readerText ? "text" : "mail";
export const DefaultClientStatus = Schema.Struct({
  available: Schema.Boolean,
  isDefault: Schema.Boolean,
});
export type DefaultClientStatus = typeof DefaultClientStatus.Type;

/** Only navigation survives a missing renderer; send/quit commands describe the current moment. */
export function shouldBufferDesktopEvent(event: DesktopEvent): boolean {
  return (
    ["ComposeFiles", "ComposeMessage", "FileError", "LinkError"].includes(event._tag) ||
    event._tag === "Navigate" ||
    event._tag === "Compose" ||
    event._tag === "Search"
  );
}

export const NotificationPermission = Schema.Literals([
  "notDetermined",
  "denied",
  "authorized",
  "provisional",
  "ephemeral",
  "unknown",
  "unavailable",
  "unsupported",
]);
export type NotificationPermission = typeof NotificationPermission.Type;

export const NotificationActionCapabilities = Schema.Struct({
  buttons: Schema.Boolean,
  selection: Schema.Boolean,
});
export const notificationActionCapabilities = (platform: string) => ({
  buttons: platform === "darwin" || platform === "win32",
  selection: platform === "win32",
});
