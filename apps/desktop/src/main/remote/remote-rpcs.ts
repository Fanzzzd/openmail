import { RpcGroup } from "effect/rpc";
import { MailRpcs } from "../../shared/rpc";

type MailRpc = RpcGroup.Rpcs<typeof MailRpcs>;
type MailTag = MailRpc["_tag"];

/**
 * How a browser on the tailnet may call an RPC.
 * - `shared`: the same core handler the desktop window uses.
 * - `remote`: a remote-only handler that never touches the Mac's OS, files,
 *   windows or clipboard (a no-op, an empty stream, or core without macOS data).
 * Anything not listed is denied. New RPCs therefore start denied.
 */
type RemoteDisposition = "shared" | "remote";

export const REMOTE_RPC_POLICY = {
  // Reading and searching
  Accounts: "shared",
  Profiles: "shared",
  Threads: "shared",
  ThreadCount: "shared",
  Thread: "shared",
  RawMessage: "shared",
  InlineImages: "shared",
  ReaderAttachments: "shared",
  EmbeddedMessage: "shared",
  InspectAttachment: "shared",
  Labels: "shared",
  UnreadCounts: "shared",
  UnreadByLabel: "shared",
  SearchServer: "shared",
  FetchOlder: "shared",
  BackfillState: "shared",
  IndexingProgress: "shared",
  MediaImage: "shared",
  CalendarEvents: "shared",
  DetectedEvents: "shared",
  Invitations: "shared",
  UndoHistory: "shared",
  FailedOps: "shared",
  Audit: "shared",
  SyncState: "shared",
  Sync: "shared",
  Events: "shared",
  // Composing and sending (sends use the same outbox and undo window)
  OpenDraft: "shared",
  DraftStatus: "shared",
  SaveDraft: "shared",
  DiscardDraft: "shared",
  ComposeAttachments: "shared",
  SendAgain: "shared",
  RecoverDraft: "shared",
  PrepareRejectedResend: "shared",
  AcknowledgeFailedOps: "shared",
  Send: "shared",
  QueueUndoSend: "shared",
  AwaitUndoSend: "shared",
  CancelWaitingSend: "shared",
  ImageFromFile: "shared",
  ImageFromUrl: "shared",
  SuggestSender: "shared",
  SuggestContacts: "shared",
  ContactAlternatives: "shared",
  ContactGroups: "shared",
  ContactPhoto: "shared",
  KnownSenders: "shared",
  HiddenContacts: "shared",
  SetContactHidden: "shared",
  SendAs: "shared",
  Signatures: "shared",
  NamedSignatures: "shared",
  SignatureDefaults: "shared",
  Templates: "shared",
  // Organising
  Modify: "shared",
  ModifyWithUndo: "shared",
  UndoBatch: "shared",
  Snooze: "shared",
  MarkUnreadFrom: "shared",
  MarkFolderRead: "shared",
  PermanentlyDelete: "shared",
  EmptyFolder: "shared",
  ChangeLabel: "shared",
  CreateLabelAndApply: "shared",
  ReorderFavorites: "shared",
  ResetFavorites: "shared",
  LabelPreferences: "shared",
  SetLabelPreference: "shared",
  Organization: "shared",
  SetOrganization: "shared",
  SetClassificationOverride: "shared",
  Unsubscribe: "shared",
  RespondInvite: "shared",
  CreateCalendarEvent: "shared",
  ImportCalendarAttachment: "shared",
  Filters: "shared",
  PreviewFilter: "shared",
  PrepareFilter: "shared",
  CreateFilter: "shared",
  UpdateFilter: "shared",
  ApplyFilter: "shared",
  DeleteFilter: "shared",
  FilterRestorations: "shared",
  PrepareFilterRestoration: "shared",
  RestoreFilter: "shared",
  DiscardFilterRestoration: "shared",
  CreateProfile: "shared",
  UpdateProfile: "shared",
  DeleteProfile: "shared",
  AssignProfile: "shared",
  Proposals: "shared",
  DecideProposal: "shared",
  AiSettings: "shared",
  AiSummary: "shared",
  Summarize: "shared",
  AskAi: "shared",
  ComposeAi: "shared",
  AiTriage: "shared",
  DecideAiTriage: "shared",
  AgentWriteMode: "shared",
  // Mail settings
  Prefs: "shared",
  SetPrefs: "remote",
  ImageSenders: "shared",
  SetImageSender: "shared",
  SetAccountSettings: "shared",
  MoveAccount: "shared",
  Vacation: "shared",
  SetVacation: "shared",
  SyncSendAs: "shared",
  SaveNamedSignature: "shared",
  DeleteNamedSignature: "shared",
  SetSignatureDefault: "shared",
  SaveTemplate: "shared",
  DeleteTemplate: "shared",
  // Calls the app makes on every window. Remote versions do nothing on the Mac.
  DesktopEvents: "remote",
  WindowUiEvents: "remote",
  SetNativeMenuState: "remote",
  SetDesktopLabels: "remote",
  SetActiveSpace: "remote",
  SetWindowRoute: "remote",
  SetSendState: "remote",
  NetworkChanged: "remote",
  NotificationActionCapabilities: "remote",
  AttachmentCapabilities: "remote",
  NativeComposeCapabilities: "remote",
  Downloads: "remote",
  UpdateState: "remote",
  CrashReportPending: "remote",
  ClaimInlineDraft: "remote",
  AppleContactsStatus: "remote",
  SpellcheckLanguages: "remote",
} as const satisfies Partial<Record<MailTag, RemoteDisposition>>;

type RemoteTag = keyof typeof REMOTE_RPC_POLICY;
type RemoteRpc = Extract<MailRpc, { readonly _tag: RemoteTag }>;

const POLICY = new Map<string, RemoteDisposition>(Object.entries(REMOTE_RPC_POLICY));

/** Unlisted tags, including ones added after this table was written, are denied. */
export const remoteDisposition = (tag: string): RemoteDisposition | "denied" =>
  POLICY.get(tag) ?? "denied";

const isRemoteRpc = (rpc: MailRpc): rpc is RemoteRpc => POLICY.has(rpc._tag);

/** The RPC group a remote client can reach. Denied RPCs have no handler at all. */
export const RemoteRpcs = RpcGroup.make(...[...MailRpcs.requests.values()].filter(isRemoteRpc));
