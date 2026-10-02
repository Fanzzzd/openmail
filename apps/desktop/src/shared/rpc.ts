import { ComposeRecipients, WindowSelection } from "./window-state";
/**
 * The app's one IPC surface: Effect RPC between the renderer and the main
 * process. Every payload, result and error is a schema, so both sides decode
 * what crosses the boundary and errors arrive with their tag intact.
 */
import {
  AttachmentPath,
  ReaderAttachment,
  EmbeddedMessage,
  AttachmentAction,
  AttachmentActionResult,
  FolderScope,
  DeleteFolder,
  DerivedChunk,
  IndexingProgress,
  CalendarInvite,
  InviteResponse,
  ContactSync,
  BackfillState,
  CacheWindow,
  CacheWindowInput,
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
  Account,
  AccountSettings,
  AccountPlacement,
  BatchResult,
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
  OutgoingAttachment,
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
import { Schema, Struct } from "effect";
import {
  DefaultClientStatus,
  DesktopEvent,
  NotificationPermission,
  NotificationActionCapabilities,
} from "./desktop";
import { DesktopLabels } from "./desktop-labels";
import { Rpc, RpcGroup } from "effect/rpc";

export const ConnectInput = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("gmail") }),
  Schema.Struct({ provider: Schema.Literal("outlook") }),
  Schema.Struct({ provider: Schema.Literal("imap"), input: ImapConnectInput }),
]);

const Counts = Schema.Record(Schema.String, Schema.Number);
/** Only the preferences being changed. */
const PrefsPatch = Schema.Struct(Struct.map(Prefs.fields, Schema.optionalKey));

/** Header labels for printing, in the UI language. */
export const PrintHeadings = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  cc: Schema.String,
  date: Schema.String,
});
const AccountIds = Schema.optionalKey(Schema.Array(Schema.String));
const error = MailError;

export class MailRpcs extends RpcGroup.make(
  Rpc.make("NotificationActionCapabilities", { success: NotificationActionCapabilities }),
  Rpc.make("NotificationPermission", { success: NotificationPermission }),
  Rpc.make("RequestNotificationPermission", { success: NotificationPermission }),
  Rpc.make("OpenNotificationSettings", { success: Schema.Boolean }),
  Rpc.make("UpdateTokenConfigured", { success: Schema.Boolean }),
  Rpc.make("SetUpdateToken", { payload: { token: Schema.String }, error }),
  Rpc.make("BackfillState", { success: Schema.Array(BackfillState) }),
  Rpc.make("PauseBackfill", { payload: { accountId: Schema.String, paused: Schema.Boolean } }),
  Rpc.make("FetchOlder", { payload: { query: ThreadQuery } }),
  Rpc.make("CacheWindows", { success: Schema.Array(CacheWindow) }),
  Rpc.make("SetCacheWindow", { payload: { input: CacheWindowInput }, error }),
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
  Rpc.make("SetAccountSettings", {
    payload: { accountId: Schema.String, input: AccountSettings },
    error,
  }),
  Rpc.make("MoveAccount", {
    payload: { accountId: Schema.String, input: AccountPlacement },
    error,
  }),
  Rpc.make("Accounts", { success: Schema.Array(Account) }),
  /** Opens the consent page (OAuth) or checks the password (IMAP), then starts a sync. */
  Rpc.make("Connect", { payload: { input: ConnectInput }, success: Account, error }),
  Rpc.make("Reauth", {
    payload: {
      accountId: Schema.String,
      feature: Schema.optionalKey(Schema.Literal("permanentDelete")),
    },
    success: Account,
    error,
  }),
  Rpc.make("ImapPresets", { success: Schema.Record(Schema.String, ImapPreset) }),
  Rpc.make("RemoveAccount", { payload: { accountId: Schema.String }, success: Outcome, error }),

  Rpc.make("IndexingProgress", { success: IndexingProgress }),
  Rpc.make("SetModelsEnabled", { payload: { enabled: Schema.Boolean } }),
  Rpc.make("SetIndexingPaused", { payload: { paused: Schema.Boolean } }),
  Rpc.make("DerivedChunks", {
    payload: { id: Schema.String },
    success: Schema.Array(DerivedChunk),
  }),
  Rpc.make("MediaImage", { payload: { chunk: DerivedChunk }, success: Schema.String, error }),
  Rpc.make("Invitations", {
    payload: { messageId: Schema.String },
    success: Schema.Array(CalendarInvite),
    error,
  }),
  /** User click only. No MCP write tool maps to this endpoint. */
  Rpc.make("RespondInvite", {
    payload: { messageId: Schema.String, key: Schema.String, response: InviteResponse },
    error,
  }),
  Rpc.make("ContactSync", { success: Schema.Array(ContactSync) }),
  Rpc.make("RefreshContacts", { payload: { accountId: Schema.String }, error }),

  // Reading
  Rpc.make("Threads", { payload: { query: ThreadQuery }, success: Schema.Array(ThreadSummary) }),
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
  Rpc.make("AttachmentCapabilities", { success: Schema.Struct({ share: Schema.Boolean }) }),
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
    },
    success: AttachmentActionResult,
    error,
  }),
  /** Asks where to save, then writes the attachment. False when the person cancelled. */
  Rpc.make("SaveAttachment", {
    payload: { messageId: Schema.String, index: Schema.Int },
    success: Schema.Boolean,
    error,
  }),
  /** Writes the attachment to a temporary folder and opens it with its default app. */
  Rpc.make("OpenAttachment", {
    payload: { messageId: Schema.String, index: Schema.Int },
    error,
  }),
  /** Asks for a folder, then writes every attachment. Returns how many were saved. */
  Rpc.make("SaveAllAttachments", {
    payload: { messageId: Schema.String },
    success: Schema.Int,
    error,
  }),
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
    payload: { accountIds: AccountIds, within: Schema.optionalKey(Schema.String) },
    success: Counts,
  }),

  Rpc.make("SearchServer", { payload: { query: ThreadQuery }, success: SearchResult }),
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

  // Spaces
  Rpc.make("Profiles", { success: Schema.Array(Profile) }),
  Rpc.make("CreateProfile", { payload: { input: ProfileInput }, success: Profile }),
  Rpc.make("UpdateProfile", { payload: { id: Schema.String, input: ProfileInput } }),
  Rpc.make("DeleteProfile", { payload: { id: Schema.String } }),
  Rpc.make("AssignProfile", {
    payload: { accountId: Schema.String, profileId: Schema.NullOr(Schema.String) },
  }),

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

  // Changes, all performed as the person at the app
  Rpc.make("ThreadCount", { payload: { query: ThreadQuery }, success: Schema.Number }),
  Rpc.make("ModifyWithUndo", {
    payload: { threads: Schema.Array(Schema.String), op: MailOp, flat: Schema.Boolean },
    success: BatchResult,
    error,
  }),
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
      /** Send and archive: archive the replied-to thread afterwards. */
      archive: Schema.optionalKey(Schema.Boolean),
    },
    success: Outcome,
    error,
  }),

  // Drafts
  /** A local draft id, a draft message id from the Drafts list, or "proposal:<id>". */
  Rpc.make("ClipboardAttachments", { success: Schema.Array(OutgoingAttachment), error }),
  Rpc.make("ComposeAttachments", {
    payload: { id: Schema.String },
    success: Schema.Array(OutgoingAttachment),
    error,
  }),
  Rpc.make("SendAgain", { payload: { id: Schema.String }, success: Draft, error }),
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
    payload: {
      query: Schema.String,
      exclude: Schema.optionalKey(Schema.String),
      accountIds: Schema.optionalKey(Schema.Array(Schema.String)),
    },
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

  // Desktop system integration. No provider or database access in these handlers.
  Rpc.make("NativeEdit", { payload: { action: Schema.Literals(["undo", "selectAll"]) } }),
  Rpc.make("NewWindow"),
  Rpc.make("ComposeNew"),
  Rpc.make("OpenSettings"),
  Rpc.make("SwitchWindow", {
    payload: { action: Schema.Literals(["nextWindow", "previousWindow", "focusMainWindow"]) },
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
  Rpc.make("SetWindowSelection", { payload: { selection: WindowSelection } }),
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
  Rpc.make("CopyMessageLink", { payload: { id: Schema.String } }),
  Rpc.make("DefaultMailClient", { success: DefaultClientStatus }),
  Rpc.make("BecomeDefaultMailClient", { success: Schema.Boolean }),
  Rpc.make("SetActiveSpace", { payload: { space: Schema.String } }),
  Rpc.make("DesktopEvents", { success: DesktopEvent, stream: true }),

  // Sync
  Rpc.make("Sync", { success: Schema.Array(SyncResult) }),
  Rpc.make("SyncState", { success: SyncState }),
  /** Sync state, progress and change notices as they happen. */
  Rpc.make("Events", { success: MailboxEvent, stream: true }),
) {}
