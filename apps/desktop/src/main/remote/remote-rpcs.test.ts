import { Effect, Fiber, Layer } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { TestMailbox } from "@openmail/core/testing/node";
import { describe, expect, it, vi } from "vitest";
import { MailRpcs } from "../../shared/rpc";
import { remotePrefs } from "./remote-handlers";
import { createConnectionHub, remoteRpcServer } from "./remote-rpc-server";
import { REMOTE_RPC_POLICY, remoteDisposition, RemoteRpcs } from "./remote-rpcs";

/**
 * The whole remote surface. Changing it is a security decision: update this
 * table on purpose, never to make a test pass.
 */
const EXPECTED_SHARED = [
  "Accounts", "Profiles", "Threads", "ThreadCount", "Thread", "RawMessage", "InlineImages",
  "ReaderAttachments", "EmbeddedMessage", "Labels", "UnreadCounts", "UnreadByLabel",
  "SearchServer", "FetchOlder", "BackfillState", "IndexingProgress", "MediaImage",
  "CalendarEvents", "DetectedEvents", "Invitations", "UndoHistory", "FailedOps", "Audit",
  "SyncState", "Sync", "Events", "OpenDraft", "DraftStatus", "SaveDraft", "DiscardDraft",
  "ComposeAttachments", "SendAgain", "RecoverDraft", "PrepareRejectedResend",
  "AcknowledgeFailedOps", "Send", "AwaitUndoSend", "CancelWaitingSend", "ImageFromFile",
  "ImageFromUrl", "SuggestSender", "HiddenContacts", "SetContactHidden", "SendAs", "Signatures",
  "NamedSignatures", "SignatureDefaults", "Templates", "Modify", "ModifyWithUndo", "UndoBatch",
  "Snooze", "MarkUnreadFrom", "MarkFolderRead", "PermanentlyDelete", "EmptyFolder",
  "ChangeLabel", "CreateLabelAndApply", "ReorderFavorites", "ResetFavorites",
  "LabelPreferences", "SetLabelPreference", "Organization", "SetOrganization", "RespondInvite",
  "CreateCalendarEvent", "Filters", "PreviewFilter", "PrepareFilter", "CreateFilter",
  "UpdateFilter", "ApplyFilter", "DeleteFilter", "FilterRestorations",
  "PrepareFilterRestoration", "RestoreFilter", "DiscardFilterRestoration", "CreateProfile",
  "UpdateProfile", "DeleteProfile", "AssignProfile", "Proposals", "DecideProposal",
  "AiSettings", "AiSummary", "Summarize", "AskAi", "ComposeAi", "AiTriage", "DecideAiTriage",
  "AgentWriteMode", "Prefs", "ImageSenders", "SetImageSender", "SetAccountSettings",
  "MoveAccount", "Vacation", "SetVacation", "SyncSendAs", "SaveNamedSignature",
  "DeleteNamedSignature", "SetSignatureDefault", "SaveTemplate", "DeleteTemplate",
  "InspectAttachment", "QueueUndoSend", "SuggestContacts", "ContactAlternatives", "ContactGroups", "ContactPhoto", "KnownSenders", "SetClassificationOverride", "Unsubscribe", "ImportCalendarAttachment",
]; // prettier-ignore
const EXPECTED_REMOTE = [
  "SetPrefs", "DesktopEvents", "WindowUiEvents", "SetNativeMenuState", "SetDesktopLabels",
  "SetActiveSpace", "SetWindowRoute", "SetSendState", "NetworkChanged",
  "NotificationActionCapabilities", "AttachmentCapabilities", "NativeComposeCapabilities",
  "Downloads", "UpdateState", "CrashReportPending", "ClaimInlineDraft", "AppleContactsStatus",
  "SpellcheckLanguages",
]; // prettier-ignore

/** Representative calls that touch the Mac's disk, OS, windows, clipboard or keys. */
const MUST_DENY = [
  "SaveAttachmentsTo", "AttachmentAction", "AttachmentApps",
  "PrepareAttachmentDrag", "ReleaseAttachmentDrag", "DownloadAction", "ClearDownloads",
  "SaveMessage", "PrintThread", "ChooseAttachmentFolder", "OpenMessageWeb", "OpenMailLink",
  "OpenMeeting", "SearchSender", "Connect", "Reauth", "SetGoogleClient", "SetMicrosoftClient",
  "ClearClient", "ClientSetup", "RemoveAccount", "SetServiceEnabled", "SetAiKey",
  "SetAiAccount", "SetAiModel", "SetAgentWriteMode", "CheckForUpdates",
  "RequestNotificationPermission", "OpenNotificationSettings",
  "BecomeDefaultMailClient", "SetAppleContacts", "OpenAppleContact", "AddAppleContact",
  "ClipboardText", "ClipboardAttachments", "CopyMessageLink", "ShareMessageLink",
  "PickNativeImages", "CheckNativeGrammar", "NativeEdit", "NewWindow", "OpenThreadWindow",
  "OpenMessageWindow", "OpenComposeWindow", "ComposeWindowDraft", "CloseComposeWindow",
  "OpenSettings", "SwitchWindow", "ComposeNew", "ComposeMessage", "TextMenuCommand",
  "AnswerPrompt", "Diagnostics", "DismissCrashReport", "ClearCache", "CompactCache",
  "SetCacheWindow", "SetModelsEnabled", "SetIndexingPaused", "RemoteAccess", "SetRemoteAccess",
  "SetRemoteAllowlist", "SetRemoteService", "DisconnectRemoteSession", "RefreshRemoteAccess",
  "AiClients", "PreviewAiClientChange", "ApplyAiClientChange",
]; // prettier-ignore

describe("remote RPC allowlist", () => {
  it("is exactly the reviewed table", () => {
    const entries = Object.entries(REMOTE_RPC_POLICY);
    expect(
      entries
        .filter(([, kind]) => kind === "shared")
        .map(([tag]) => tag)
        .toSorted(),
    ).toEqual(EXPECTED_SHARED.toSorted());
    expect(
      entries
        .filter(([, kind]) => kind === "remote")
        .map(([tag]) => tag)
        .toSorted(),
    ).toEqual(EXPECTED_REMOTE.toSorted());
  });

  it("denies everything else, including RPCs added after the table", () => {
    for (const tag of MUST_DENY) {
      expect(MailRpcs.requests.has(tag), tag).toBe(true);
      expect(remoteDisposition(tag), tag).toBe("denied");
      expect(RemoteRpcs.requests.has(tag), tag).toBe(false);
    }
    // A brand-new RPC is denied without anyone touching the table.
    const grown = RpcGroup.make(...MailRpcs.requests.values(), Rpc.make("BrandNewMacFeature"));
    expect(grown.requests.has("BrandNewMacFeature")).toBe(true);
    expect(remoteDisposition("BrandNewMacFeature")).toBe("denied");
    expect(remoteDisposition("constructor")).toBe("denied");
    expect(remoteDisposition("__proto__")).toBe("denied");
    const listed = new Set(Object.keys(REMOTE_RPC_POLICY));
    for (const tag of MailRpcs.requests.keys())
      expect(RemoteRpcs.requests.has(tag), tag).toBe(listed.has(tag));
  });

  // "shared" entries must exist in mailboxHandlers: RemoteRpcs.of fails to type-check otherwise.
  it("lists only real RPCs", () => {
    for (const tag of Object.keys(REMOTE_RPC_POLICY))
      expect(MailRpcs.requests.has(tag), tag).toBe(true);
  });

  it("lets remote clients change mail preferences only", async () => {
    const ok = await Effect.runPromiseExit(
      remotePrefs({ remoteImages: "ask", threadOrder: "newest" }),
    );
    expect(ok._tag).toBe("Success");
    for (const patch of [
      { useAppleContacts: true },
      { attachmentSaveFolder: { kind: "downloads" as const } },
      { updateChannel: "latest" as const },
      { notifications: {} },
      { menuBarUnreadCount: true },
      { attachmentCacheBytes: 0 },
      { spellcheck: false },
    ]) {
      const exit = await Effect.runPromiseExit(remotePrefs({ readerZoom: 100, ...patch }));
      expect(exit._tag, JSON.stringify(patch)).toBe("Failure");
    }
  });
});

interface Frame {
  _tag: string;
  requestId?: string;
  exit?: { _tag: string; cause?: { _tag: string }[] };
}

describe("remote RPC server", () => {
  it("answers listed RPCs with core data and fails denied ones without running them", async () => {
    const hub = createConnectionHub();
    const denied: string[] = [];
    const failures: unknown[] = [];
    const fiber = Effect.runFork(
      Layer.launch(
        remoteRpcServer(hub, {
          denied: (tag) => denied.push(tag),
          failure: (failure) => failures.push(failure),
        }),
      ).pipe(Effect.provide(TestMailbox())),
    );
    await vi.waitFor(() => expect(hub.listening).toBe(true), {
      interval: 10,
    });
    const frames: Frame[] = [];
    let closed: number | undefined;
    const connection = hub.onConnection({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: the server's JSON frame.
      send: (frame) => frames.push(JSON.parse(frame) as Frame),
      close: (code) => {
        closed = code;
      },
    });
    const request = (id: string, tag: string, payload: unknown = null) =>
      connection.message(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    request("1", "Accounts");
    request("2", "SaveAttachmentsTo", { messageId: "m", paths: [[0]] });
    request("3", "SetRemoteAllowlist", { logins: ["attacker@example.com"] });
    request("4", "ClipboardText");
    const exit = (id: string) => frames.find((frame) => frame.requestId === id)?.exit;
    await vi.waitFor(() => expect(["1", "2", "3", "4"].map(exit)).not.toContain(undefined), {
      interval: 10,
    });
    expect(exit("1")?._tag).toBe("Success");
    for (const id of ["2", "3", "4"]) {
      expect(exit(id)?._tag, id).toBe("Failure");
      // No stack or tag detail leaks out.
      expect(JSON.stringify(exit(id))).not.toContain("Unknown request tag");
    }
    // The log names each denied RPC and how it failed, never the payload.
    expect(denied).toEqual(["SaveAttachmentsTo", "SetRemoteAllowlist", "ClipboardText"]);
    expect(failures).toEqual(
      ["SaveAttachmentsTo", "SetRemoteAllowlist", "ClipboardText"].map((rpc) => ({
        rpc,
        kind: "defect",
        error: "Other",
      })),
    );
    expect(JSON.stringify(failures)).not.toContain("attacker");
    // Tags outside MailRpcs never reach the server: the socket closes.
    request("5", "BrandNewMacFeature");
    expect(closed).toBe(1008);
    connection.closed();
    await Effect.runPromise(Fiber.interrupt(fiber));
  });
});
