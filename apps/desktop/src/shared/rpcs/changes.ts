import {
  FolderScope,
  DeleteFolder,
  BatchResult,
  UndoHistoryEntry,
  AuditEntry,
  FailedOp,
  DraftInput,
  InferenceClassification,
  MailOp,
  Outcome,
  OutgoingMessage,
  ThreadQuery,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Changes, all performed as the person at the app. */
export const ChangeRpcs = [
  Rpc.make("PermanentlyDelete", {
    payload: {
      threads: Schema.Array(Schema.String),
      flat: Schema.Boolean,
      confirmed: Schema.Boolean,
      folder: DeleteFolder,
    },
    success: Schema.Number,
    error,
  }),
  Rpc.make("EmptyFolder", {
    payload: { folder: FolderScope, confirmed: Schema.Boolean },
    success: Schema.Number,
    error,
  }),
  Rpc.make("MarkFolderRead", { payload: { folder: FolderScope }, success: Schema.Number, error }),
  Rpc.make("ResetFavorites", { payload: { accountIds: Schema.Array(Schema.String) }, error }),

  Rpc.make("ThreadCount", { payload: { query: ThreadQuery }, success: Schema.Number, error }),
  Rpc.make("SetClassificationOverride", {
    payload: { messageId: Schema.String, classifyAs: InferenceClassification },
    error,
  }),
  Rpc.make("ModifyWithUndo", {
    payload: { threads: Schema.Array(Schema.String), op: MailOp, flat: Schema.Boolean },
    success: BatchResult,
    error,
  }),
  Rpc.make("UndoHistory", { success: Schema.Array(UndoHistoryEntry) }),
  Rpc.make("UndoBatch", { payload: { undoId: Schema.String }, error }),
  Rpc.make("Modify", {
    payload: { threads: Schema.Array(Schema.String), op: MailOp },
    success: Outcome,
    error,
  }),
  /** Called only after the person pressed Send and the undo window passed. */
  Rpc.make("Send", {
    payload: {
      accountId: Schema.String,
      message: OutgoingMessage,
      /** The saved draft being sent; it is removed once the message is out. */
      draftId: Schema.optionalKey(Schema.String),
      confirmResend: Schema.optionalKey(Schema.Boolean),
      /** Send and archive: archive the replied-to thread afterwards. */
      archive: Schema.optionalKey(Schema.Boolean),
    },
    success: Outcome,
    error,
  }),

  Rpc.make("QueueUndoSend", {
    payload: {
      draft: DraftInput,
      due: Schema.Finite,
      archive: Schema.optionalKey(Schema.Boolean),
      confirmResend: Schema.optionalKey(Schema.Boolean),
    },
    error,
  }),
  Rpc.make("AwaitUndoSend", { payload: { id: Schema.String }, success: Outcome, error }),
  Rpc.make("CancelWaitingSend", { payload: { id: Schema.String }, success: Schema.Boolean }),
  Rpc.make("PrepareRejectedResend", {
    payload: { noticeId: Schema.Int },
    success: DraftInput,
    error,
  }),
  Rpc.make("FailedOps", { success: Schema.Array(FailedOp), error }),
  Rpc.make("AcknowledgeFailedOps", { payload: { ids: Schema.Array(Schema.Int) }, error }),
  Rpc.make("Audit", { payload: { limit: Schema.Int }, success: Schema.Array(AuditEntry) }),
] as const;
