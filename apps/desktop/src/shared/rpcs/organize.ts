import {
  AccountOrganization,
  FilterCriteria,
  FilterPreview,
  FilterRestoration,
  FilterRestorationPreview,
  FilterInput,
  LabelChange,
  LabelPreference,
  SearchResult,
  SendAs,
  ServerFilter,
  Vacation,
  BatchResult,
  ThreadQuery,
  ThreadSummary,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** Server search, labels, filters, vacation replies and send-as addresses. */
export const OrganizeRpcs = [
  Rpc.make("SearchServer", { payload: { query: ThreadQuery }, success: SearchResult, error }),
  Rpc.make("ChangeLabel", { payload: { accountId: Schema.String, change: LabelChange }, error }),
  Rpc.make("ReorderFavorites", {
    payload: {
      order: Schema.Array(Schema.Struct({ accountId: Schema.String, id: Schema.String })),
    },
    error,
  }),
  Rpc.make("LabelPreferences", { success: Schema.Array(LabelPreference) }),
  Rpc.make("SetLabelPreference", { payload: { input: LabelPreference }, error }),
  Rpc.make("Organization", { success: Schema.Array(AccountOrganization) }),
  Rpc.make("SetOrganization", { payload: { input: AccountOrganization }, error }),
  Rpc.make("Snooze", {
    success: BatchResult,
    payload: { threads: Schema.Array(Schema.String), due: Schema.Number },
    error,
  }),
  Rpc.make("Filters", {
    payload: { accountId: Schema.String },
    success: Schema.Array(ServerFilter),
    error,
  }),
  Rpc.make("PreviewFilter", {
    payload: { accountId: Schema.String, criteria: FilterCriteria },
    success: Schema.Array(ThreadSummary),
    error,
  }),
  Rpc.make("PrepareFilter", {
    payload: { accountId: Schema.String, input: FilterInput },
    success: FilterPreview,
    error,
  }),
  Rpc.make("FilterRestorations", {
    payload: { accountId: Schema.String },
    success: Schema.Array(FilterRestoration),
    error,
  }),
  Rpc.make("RestoreFilter", {
    payload: {
      accountId: Schema.String,
      id: Schema.String,
      token: Schema.String,
      queryDeletionConfirmed: Schema.optionalKey(Schema.Literal(true)),
    },
    success: ServerFilter,
    error,
  }),
  Rpc.make("PrepareFilterRestoration", {
    payload: { accountId: Schema.String, id: Schema.String },
    success: FilterRestorationPreview,
    error,
  }),
  Rpc.make("DiscardFilterRestoration", {
    payload: { accountId: Schema.String, id: Schema.String, confirmed: Schema.Boolean },
    error,
  }),
  Rpc.make("UpdateFilter", {
    payload: {
      accountId: Schema.String,
      id: Schema.String,
      input: FilterInput,
      token: Schema.String,
    },
    success: ServerFilter,
    error,
  }),
  Rpc.make("ApplyFilter", {
    payload: { accountId: Schema.String, input: FilterInput, token: Schema.String },
    success: Schema.Number,
    error,
  }),
  Rpc.make("CreateLabelAndApply", {
    payload: {
      accountId: Schema.String,
      name: Schema.String,
      parentId: Schema.NullOr(Schema.String),
      threads: Schema.Array(Schema.String),
      move: Schema.Boolean,
      removeLabelId: Schema.NullOr(Schema.String),
      flat: Schema.Boolean,
    },
    success: BatchResult,
    error,
  }),
  Rpc.make("CreateFilter", {
    payload: {
      accountId: Schema.String,
      input: FilterInput,
      token: Schema.optionalKey(Schema.String),
    },
    success: ServerFilter,
    error,
  }),
  Rpc.make("DeleteFilter", {
    payload: {
      accountId: Schema.String,
      id: Schema.String,
      confirmed: Schema.Boolean,
    },
    error,
  }),
  Rpc.make("Vacation", { payload: { accountId: Schema.String }, success: Vacation, error }),
  Rpc.make("SetVacation", { payload: { accountId: Schema.String, input: Vacation }, error }),
  Rpc.make("SendAs", { success: Schema.Array(SendAs) }),
  Rpc.make("SyncSendAs", { payload: { accountId: Schema.String }, error }),
] as const;
