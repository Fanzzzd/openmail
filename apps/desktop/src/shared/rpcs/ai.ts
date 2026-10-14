import {
  DerivedChunk,
  IndexingProgress,
  AiSettings,
  AiAccountSettings,
  AiModelName,
  AiSummary,
  AiEvent,
  AiQuestion,
  AiComposeRequest,
  AiTriage,
  AgentWriteMode,
  Outcome,
  Proposal,
} from "@openmail/core/schema";
import { AiClientChange, AiClientError, AiClientPreview, AiClientsView } from "../ai-clients";
import { Schema } from "effect";
import { Rpc } from "effect/rpc";
import { error } from "./fields";

/** AI summaries, triage, local indexing, agent proposals and the AI apps that start OpenMail's MCP server. */
export const AiRpcs = [
  Rpc.make("AiSettings", { success: AiSettings, error }),
  Rpc.make("SetAiKey", { payload: { key: Schema.String }, error }),
  Rpc.make("SetAiAccount", { payload: { input: AiAccountSettings }, error }),
  Rpc.make("SetAiModel", { payload: { model: AiModelName } }),
  Rpc.make("AiSummary", {
    payload: { id: Schema.String, locale: Schema.optionalKey(Schema.String) },
    success: Schema.NullOr(AiSummary),
    error,
  }),
  Rpc.make("Summarize", {
    // The UI language, so the summary comes back in it; summaries are cached per language.
    payload: { id: Schema.String, locale: Schema.optionalKey(Schema.String) },
    success: AiEvent,
    stream: true,
    error,
  }),
  Rpc.make("AskAi", { payload: { input: AiQuestion }, success: AiEvent, stream: true, error }),
  Rpc.make("ComposeAi", {
    payload: { input: AiComposeRequest },
    success: AiEvent,
    stream: true,
    error,
  }),
  Rpc.make("AiTriage", { payload: { id: Schema.String }, success: Schema.NullOr(AiTriage), error }),
  Rpc.make("DecideAiTriage", { payload: { id: Schema.String, accept: Schema.Boolean }, error }),
  Rpc.make("IndexingProgress", { success: IndexingProgress }),
  Rpc.make("SetModelsEnabled", { payload: { enabled: Schema.Boolean } }),
  Rpc.make("SetIndexingPaused", { payload: { paused: Schema.Boolean } }),
  Rpc.make("MediaImage", { payload: { chunk: DerivedChunk }, success: Schema.String, error }),
  Rpc.make("Proposals", { success: Schema.Array(Proposal) }),
  Rpc.make("DecideProposal", {
    payload: { id: Schema.Number, approve: Schema.Boolean },
    success: Outcome,
    error,
  }),
  Rpc.make("AgentWriteMode", { success: AgentWriteMode }),
  Rpc.make("SetAgentWriteMode", { payload: { mode: AgentWriteMode } }),
  // AI apps that start OpenMail's MCP server. Desktop only: they read and edit the Mac's files.
  Rpc.make("AiClients", { success: AiClientsView }),
  Rpc.make("PreviewAiClientChange", {
    payload: { change: AiClientChange },
    success: AiClientPreview,
    error: AiClientError,
  }),
  Rpc.make("ApplyAiClientChange", {
    payload: { change: AiClientChange, token: Schema.String.check(Schema.isMaxLength(128)) },
    error: AiClientError,
  }),
] as const;
