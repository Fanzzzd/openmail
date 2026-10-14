import { ComposeRecipients } from "../window-state";
import { Draft } from "@openmail/core/schema";
import { DefaultClientStatus, DesktopEvent, UndoNoticeFields } from "../desktop";
import { DesktopLabels } from "../desktop-labels";
import { PromptAnswer, TextMenuCommand, WindowUiEvent } from "../window-ui";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Desktop system integration. No provider or database access in these handlers. */
export const DesktopRpcs = [
  Rpc.make("NativeEdit", { payload: { action: Schema.Literals(["undo", "selectAll"]) } }),
  Rpc.make("NewWindow"),
  Rpc.make("Unsubscribe", { payload: { messageId: Schema.String }, error }),
  Rpc.make("OpenMailLink", {
    payload: { url: Schema.String.check(Schema.isMaxLength(100_000)) },
    error,
  }),
  Rpc.make("ComposeNew"),
  /** Shows an undo toast in the main window for an action taken in a window that closes. */
  Rpc.make("ShowUndo", { payload: UndoNoticeFields }),
  Rpc.make("OpenSettings"),
  Rpc.make("SwitchWindow", {
    payload: {
      action: Schema.Literals([
        "nextWindow",
        "previousWindow",
        "focusMainWindow",
        "toggleFullScreen",
        "nextTab",
        "previousTab",
      ]),
    },
  }),
  Rpc.make("ClipboardText", { success: Schema.String }),
  Rpc.make("ClaimInlineDraft", {
    payload: { id: Schema.NullOr(Schema.String) },
    success: Schema.Boolean,
  }),
  Rpc.make("OpenComposeWindow", {
    payload: {
      id: Schema.String,
      recipients: Schema.optionalKey(ComposeRecipients),
      transfer: Schema.optionalKey(Schema.Boolean),
    },
    error,
  }),
  Rpc.make("ComposeWindowDraft", {
    payload: { id: Schema.String },
    success: Schema.Struct({ draft: Draft, recipients: Schema.NullOr(ComposeRecipients) }),
    error,
  }),
  Rpc.make("CloseComposeWindow"),
  /** The window's route for restore; main keeps only mail routes of main windows. */
  Rpc.make("SetWindowRoute", { payload: { href: Schema.String } }),
  Rpc.make("Diagnostics", { payload: { crashOnly: Schema.Boolean }, success: Schema.String }),
  Rpc.make("CrashReportPending", { success: Schema.Boolean }),
  Rpc.make("DismissCrashReport"),
  Rpc.make("FeedbackAddress", { success: Schema.String }),
  Rpc.make("SetSendState", {
    payload: {
      pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      undoAvailable: Schema.Boolean,
    },
  }),
  Rpc.make("SetDesktopLabels", { payload: { labels: DesktopLabels } }),
  Rpc.make("CopyMessageLink", {
    payload: {
      id: Schema.String,
      kind: Schema.optionalKey(Schema.Literals(["message", "thread", "web"])),
    },
    error,
  }),
  Rpc.make("DefaultMailClient", { success: DefaultClientStatus }),
  Rpc.make("BecomeDefaultMailClient", { success: Schema.Boolean }),
  Rpc.make("SetActiveSpace", { payload: { space: Schema.String } }),
  Rpc.make("DesktopEvents", { success: DesktopEvent, stream: true }),
  /** Menus and prompts this window draws for the main process. */
  Rpc.make("WindowUiEvents", { success: WindowUiEvent, stream: true }),
  Rpc.make("AnswerPrompt", { payload: { id: Schema.String, answer: PromptAnswer } }),
  Rpc.make("TextMenuCommand", { payload: { command: TextMenuCommand } }),
] as const;
