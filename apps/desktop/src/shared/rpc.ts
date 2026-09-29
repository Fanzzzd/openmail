/**
 * The app's one IPC surface: Effect RPC between the renderer and the main
 * process. Every payload, result and error is a schema, so both sides decode
 * what crosses the boundary and errors arrive with their tag intact.
 */
import {
  Account,
  AgentWriteMode,
  AuditEntry,
  ImapConnectInput,
  ImapPreset,
  Label,
  MailError,
  MailboxEvent,
  MailOp,
  Message,
  Outcome,
  OutgoingMessage,
  Profile,
  ProfileInput,
  Proposal,
  SyncResult,
  SyncState,
  ThreadQuery,
  ThreadSummary,
} from "@openmail/core/schema";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const ConnectInput = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("gmail") }),
  Schema.Struct({ provider: Schema.Literal("outlook") }),
  Schema.Struct({ provider: Schema.Literal("imap"), input: ImapConnectInput }),
]);

const Counts = Schema.Record(Schema.String, Schema.Number);
const AccountIds = Schema.optionalKey(Schema.Array(Schema.String));
const error = MailError;

export class MailRpcs extends RpcGroup.make(
  // Accounts and sign-in
  Rpc.make("ClientSetup", {
    success: Schema.Struct({
      googleConfigured: Schema.Boolean,
      microsoftConfigured: Schema.Boolean,
    }),
  }),
  Rpc.make("SetGoogleClient", {
    payload: { clientId: Schema.String, clientSecret: Schema.String },
  }),
  Rpc.make("SetMicrosoftClient", { payload: { clientId: Schema.String } }),
  Rpc.make("Accounts", { success: Schema.Array(Account) }),
  /** Opens the consent page (OAuth) or checks the password (IMAP), then starts a sync. */
  Rpc.make("Connect", { payload: { input: ConnectInput }, success: Account, error }),
  Rpc.make("Reauth", { payload: { accountId: Schema.String }, success: Account, error }),
  Rpc.make("ImapPresets", { success: Schema.Record(Schema.String, ImapPreset) }),
  Rpc.make("RemoveAccount", { payload: { accountId: Schema.String }, success: Outcome, error }),

  // Reading
  Rpc.make("Threads", { payload: { query: ThreadQuery }, success: Schema.Array(ThreadSummary) }),
  Rpc.make("Thread", { payload: { id: Schema.String }, success: Schema.Array(Message), error }),
  Rpc.make("Labels", { payload: { accountIds: AccountIds }, success: Schema.Array(Label) }),
  Rpc.make("UnreadCounts", { success: Counts }),
  Rpc.make("UnreadByLabel", {
    payload: { accountIds: AccountIds, within: Schema.optionalKey(Schema.String) },
    success: Counts,
  }),

  // Spaces
  Rpc.make("Profiles", { success: Schema.Array(Profile) }),
  Rpc.make("CreateProfile", { payload: { input: ProfileInput }, success: Profile }),
  Rpc.make("UpdateProfile", { payload: { id: Schema.String, input: ProfileInput } }),
  Rpc.make("DeleteProfile", { payload: { id: Schema.String } }),
  Rpc.make("AssignProfile", {
    payload: { accountId: Schema.String, profileId: Schema.NullOr(Schema.String) },
  }),

  // Changes, all performed as the person at the app
  Rpc.make("Modify", {
    payload: { threads: Schema.Array(Schema.String), op: MailOp },
    success: Outcome,
    error,
  }),
  /** Called only after the person pressed Send and the undo window passed. */
  Rpc.make("Send", {
    payload: { accountId: Schema.String, message: OutgoingMessage },
    success: Outcome,
    error,
  }),
  Rpc.make("Audit", { payload: { limit: Schema.Int }, success: Schema.Array(AuditEntry) }),
  Rpc.make("Proposals", { success: Schema.Array(Proposal) }),
  Rpc.make("DecideProposal", {
    payload: { id: Schema.Number, approve: Schema.Boolean },
    success: Outcome,
    error,
  }),
  Rpc.make("AgentWriteMode", { success: AgentWriteMode }),
  Rpc.make("SetAgentWriteMode", { payload: { mode: AgentWriteMode } }),

  // Sync
  Rpc.make("Sync", { success: Schema.Array(SyncResult) }),
  Rpc.make("SyncState", { success: SyncState }),
  /** Sync state, progress and change notices as they happen. */
  Rpc.make("Events", { success: MailboxEvent, stream: true }),
) {}
