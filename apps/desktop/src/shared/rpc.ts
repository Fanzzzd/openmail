/**
 * The app's one IPC surface: Effect RPC between the renderer and the main
 * process. Every payload, result and error is a schema, so both sides decode
 * what crosses the boundary and errors arrive with their tag intact.
 */
import {
  Account,
  Address,
  AgentWriteMode,
  AuditEntry,
  Draft,
  DraftInput,
  ImapConnectInput,
  ImapPreset,
  Label,
  MailError,
  MailboxEvent,
  MailOp,
  Message,
  Outcome,
  OutgoingMessage,
  Prefs,
  Profile,
  ProfileInput,
  Proposal,
  Signature,
  SyncResult,
  SyncState,
  Template,
  TemplateInput,
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
/** Only the preferences being changed. */
const PrefsPatch = Schema.Struct({
  undoSendSeconds: Schema.optionalKey(Prefs.fields.undoSendSeconds),
  language: Schema.optionalKey(Prefs.fields.language),
});
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
    payload: {
      accountId: Schema.String,
      message: OutgoingMessage,
      /** The saved draft being sent; it is removed once the message is out. */
      draftId: Schema.optionalKey(Schema.String),
      /** Send and archive: archive the replied-to thread afterwards. */
      archive: Schema.optionalKey(Schema.Boolean),
    },
    success: Outcome,
    error,
  }),

  // Drafts
  /** A local draft id, a draft message id from the Drafts list, or "proposal:<id>". */
  Rpc.make("OpenDraft", { payload: { id: Schema.String }, success: Draft, error }),
  Rpc.make("SaveDraft", { payload: { draft: DraftInput }, success: Draft, error }),
  Rpc.make("DiscardDraft", { payload: { id: Schema.String } }),

  // Compose settings
  Rpc.make("Prefs", { success: Prefs }),
  Rpc.make("SetPrefs", { payload: { patch: PrefsPatch } }),
  Rpc.make("Signatures", { success: Schema.Array(Signature) }),
  Rpc.make("SetSignature", { payload: { signature: Signature } }),
  Rpc.make("Templates", { success: Schema.Array(Template) }),
  Rpc.make("SaveTemplate", {
    payload: { input: TemplateInput, id: Schema.optionalKey(Schema.String) },
    success: Template,
    error,
  }),
  Rpc.make("DeleteTemplate", { payload: { id: Schema.String } }),
  Rpc.make("SuggestContacts", {
    payload: { query: Schema.String, exclude: Schema.optionalKey(Schema.String) },
    success: Schema.Array(Address),
  }),
  Rpc.make("HiddenContacts", { success: Schema.Array(Schema.String) }),
  Rpc.make("SetContactHidden", { payload: { address: Schema.String, hidden: Schema.Boolean } }),
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
