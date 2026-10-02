import { notificationActionCapabilities } from "../shared/desktop";
import { notificationPermission, openNotificationSettings } from "./notification-permission";
import { becomeDefaultClient, defaultClientStatus } from "./default-client";
import { IMAP_PRESETS, Mailbox, messageLink, senderSearchQuery } from "@openmail/core";
import { Effect, FiberSet, Layer, Queue } from "effect";
import { type RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { BrowserWindow, clipboard, ipcMain, type IpcMainEvent, webContents, shell } from "electron";

import { RPC_CHANNEL } from "../shared/channel";
import { MailRpcs } from "../shared/rpc";
import {
  openAttachment,
  printThread,
  saveAllAttachments,
  saveAttachment,
  saveMessage,
} from "./files";
import { openMeeting } from "./meeting";
import { Desktop } from "./system";
import { createMainWindow, openThreadWindow, openMessageWindow, windowOf } from "./windows";

/** Brings the app back to the front after a sign-in in the system browser. */
const focusApp = Effect.sync(() => BrowserWindow.getAllWindows()[0]?.focus());

/** Everything the renderer changes runs as the person at the app. */
const USER = { kind: "user", surface: "app" } as const;

/**
 * RPC server transport over Electron IPC. Each renderer (webContents) is one
 * client; its id is the client id. Frames are JSON strings.
 */
const ElectronProtocol = Layer.effect(
  RpcServer.Protocol,
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    return yield* RpcServer.Protocol.make(
      Effect.fnUntraced(function* (writeRequest) {
        const disconnects = yield* Queue.make<number>();
        const clients = new Set<number>();
        const parser = serialization.makeUnsafe();
        const run = yield* FiberSet.makeRuntime();

        const onFrame = (event: IpcMainEvent, frame: string) => {
          const client = event.sender;
          if (!clients.has(client.id)) {
            clients.add(client.id);
            client.once("destroyed", () => {
              clients.delete(client.id);
              run(Queue.offer(disconnects, client.id));
            });
          }
          run(
            Effect.forEach(
              parser.decode(frame) as ReadonlyArray<RpcMessage.FromClientEncoded>,
              (message) => writeRequest(client.id, message),
              { discard: true },
            ),
          );
        };
        ipcMain.on(RPC_CHANNEL, onFrame);
        yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.off(RPC_CHANNEL, onFrame)));

        return {
          disconnects,
          send: (clientId, response) =>
            Effect.sync(() => {
              const frame = parser.encode(response);
              const target = webContents.fromId(clientId);
              if (typeof frame === "string" && target && !target.isDestroyed()) {
                target.send(RPC_CHANNEL, frame);
              }
            }),
          end: () => Effect.void,
          clientIds: Effect.sync(() => new Set(clients)),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: true,
          supportsNotifications: true,
          codecFor: serialization.codecFor,
        };
      }),
    );
  }),
);

const Handlers = MailRpcs.toLayer(
  Effect.gen(function* () {
    const m = yield* Mailbox;
    const desktop = yield* Desktop;
    return MailRpcs.of({
      ClientSetup: () => m.clientSetup,
      SetGoogleClient: ({ clientId, clientSecret }) =>
        m.setClient({ google: { clientId: clientId.trim(), clientSecret: clientSecret.trim() } }),
      SetMicrosoftClient: ({ clientId }) =>
        m.setClient({ microsoft: { clientId: clientId.trim() } }),
      NotificationActionCapabilities: () =>
        Effect.succeed(notificationActionCapabilities(process.platform)),
      NotificationPermission: () => Effect.promise(() => notificationPermission()),
      RequestNotificationPermission: () => Effect.promise(() => notificationPermission(true)),
      OpenNotificationSettings: () => Effect.promise(openNotificationSettings),
      Accounts: () => m.accounts,
      SetAccountSettings: ({ accountId, input }) => m.setAccountSettings(accountId, input),
      MoveAccount: ({ accountId, input }) => m.moveAccount(accountId, input),
      Connect: ({ input }) => Effect.tap(m.connect(input), () => focusApp),
      Reauth: ({ accountId }) => Effect.tap(m.reauth(accountId), () => focusApp),
      ImapPresets: () => Effect.succeed(IMAP_PRESETS),
      RemoveAccount: ({ accountId }) => m.perform({ kind: "removeAccount", accountId }, USER),

      Invitations: ({ messageId }) => m.invitations(messageId),
      RespondInvite: ({ messageId, key, response }) =>
        m.respondInvite(messageId, key, response, USER),
      ContactSync: () => m.contactSync,
      RefreshContacts: ({ accountId }) => m.refreshContacts(accountId),

      Threads: ({ query }) => m.threads(query),
      ThreadCount: ({ query }) => m.threadCount(query),
      Thread: ({ id }) => m.readerThread(id),
      RawMessage: ({ id }) => m.rawMessage(id),
      SaveMessage: ({ id }, { client }) => saveMessage(m, windowOf(client.id), id),
      OpenMessageWeb: ({ id }) =>
        m
          .messageWebUrl(id)
          .pipe(Effect.flatMap((url) => Effect.promise(() => shell.openExternal(url)))),
      KnownSenders: ({ accountId, addresses }) => m.knownSenders(accountId, addresses),
      SearchSender: ({ address }) => desktop.search(senderSearchQuery(address)),
      IndexingProgress: () => m.indexingProgress,
      SetModelsEnabled: ({ enabled }) => m.setModelsEnabled(enabled),
      SetIndexingPaused: ({ paused }) => m.setIndexingPaused(paused),
      DerivedChunks: ({ id }) => m.derivedChunks(id),
      MediaImage: ({ chunk }) => m.mediaImage(chunk),
      InlineImages: ({ id }) => m.inlineImages(id),
      ImageSenders: () => m.imageSenders,
      SetImageSender: ({ entry, allowed }) => m.setImageSender(entry, allowed),
      SaveAttachment: ({ messageId, index }, { client }) =>
        saveAttachment(m, windowOf(client.id), messageId, index),
      OpenAttachment: ({ messageId, index }) => openAttachment(m, messageId, index),
      SaveAllAttachments: ({ messageId }, { client }) =>
        saveAllAttachments(m, windowOf(client.id), messageId),
      PrintThread: (request, { client }) => printThread(m, windowOf(client.id), request),
      OpenThreadWindow: ({ id }) =>
        Effect.sync(() => {
          openThreadWindow(id);
        }),
      OpenMessageWindow: ({ id }) =>
        Effect.sync(() => {
          openMessageWindow(id);
        }),
      OpenMeeting: ({ url }) => openMeeting(url),
      MarkUnreadFrom: ({ id }) => m.markUnreadFrom(id),
      Labels: ({ accountIds }) => m.labels(accountIds),
      UnreadCounts: () => m.unreadCounts,
      UnreadByLabel: ({ accountIds, within }) => m.unreadByLabel(accountIds, within),

      UpdateTokenConfigured: () => m.updateTokenConfigured,
      SetUpdateToken: ({ token }) => m.setUpdateToken(token),
      BackfillState: () => m.backfillState,
      PauseBackfill: ({ accountId, paused }) => m.pauseBackfill(accountId, paused),
      FetchOlder: ({ query }) => m.fetchOlder(query),
      CacheWindows: () => m.cacheWindows,
      SetCacheWindow: ({ input }) => m.setCacheWindow(input),
      SearchServer: ({ query }) => m.searchServer(query),
      ChangeLabel: ({ accountId, change }) => m.changeLabel(accountId, change),
      LabelPreferences: () => m.labelPreferences,
      SetLabelPreference: ({ input }) => m.setLabelPreference(input),
      Organization: () => m.organization,
      SetOrganization: ({ input }) => m.setOrganization(input),
      Snooze: ({ threads, due }) => m.snooze(threads, due),
      Filters: ({ accountId }) => m.filters(accountId),
      PreviewFilter: ({ accountId, criteria }) => m.previewFilter(accountId, criteria),
      CreateFilter: ({ accountId, input }) => m.createFilter(accountId, input),
      DeleteFilter: ({ accountId, id }) => m.deleteFilter(accountId, id),
      Vacation: ({ accountId }) => m.vacation(accountId),
      SetVacation: ({ accountId, input }) => m.setVacation(accountId, input),
      SendAs: () => m.sendAs,
      SyncSendAs: ({ accountId }) => m.syncSendAs(accountId),

      Profiles: () => m.profiles,
      CreateProfile: ({ input }) => m.createProfile(input),
      UpdateProfile: ({ id, input }) => m.updateProfile(id, input),
      DeleteProfile: ({ id }) => m.deleteProfile(id),
      AssignProfile: ({ accountId, profileId }) => m.assignProfile(accountId, profileId),

      Modify: ({ threads, op }) => m.perform({ kind: "modify", threads, op }, USER),
      ModifyWithUndo: ({ threads, op, flat }) => m.modifyWithUndo(threads, op, flat),
      UndoBatch: ({ undoId }) => m.undoBatch(undoId),
      Send: ({ accountId, message, draftId, archive }) =>
        m.perform(
          {
            kind: "send",
            accountId,
            message,
            ...(draftId === undefined ? {} : { draftId }),
            ...(archive === undefined ? {} : { archive }),
          },
          USER,
        ),

      SendAgain: ({ id }) => m.sendAgain(id),
      OpenDraft: ({ id }) => m.openDraft(id),
      SaveDraft: ({ draft }) => m.saveDraft(draft),
      DiscardDraft: ({ id }) => m.discardDraft(id),

      Prefs: () => m.prefs,
      SetPrefs: ({ patch }) => m.setPrefs(patch),
      Signatures: () => m.signatures,
      SetSignature: ({ signature }) => m.setSignature(signature),
      Templates: () => m.templates,
      SaveTemplate: ({ input, id }) => m.saveTemplate(input, id),
      DeleteTemplate: ({ id }) => m.deleteTemplate(id),
      SuggestContacts: ({ query, exclude }) =>
        m.suggestContacts(query, exclude === undefined ? {} : { exclude }),
      HiddenContacts: () => m.hiddenContacts,
      SetContactHidden: ({ address, hidden }) => m.setContactHidden(address, hidden),
      Audit: ({ limit }) => m.audit(limit),
      Proposals: () => m.proposals,
      DecideProposal: ({ id, approve }) => m.decideProposal(id, approve, "app"),
      AgentWriteMode: () => m.agentWriteMode,
      SetAgentWriteMode: ({ mode }) => m.setAgentWriteMode(mode),

      NewWindow: () =>
        Effect.sync(() => {
          createMainWindow();
        }),
      CopyMessageLink: ({ id }) => Effect.promise(() => clipboard.writeText(messageLink(id))),
      DefaultMailClient: () => Effect.sync(defaultClientStatus),
      BecomeDefaultMailClient: () => Effect.sync(becomeDefaultClient),
      SetActiveSpace: ({ space }, { client }) => desktop.setSpace(client.id, space),
      NativeEdit: ({ action }, { client }) =>
        Effect.sync(() => {
          const target = webContents.fromId(client.id);
          if (action === "undo") target?.undo();
          else target?.selectAll();
        }),
      SetSendState: (state, { client }) => desktop.setSendState(client.id, state),
      SetDesktopLabels: ({ labels }) => desktop.setLabels(labels),
      DesktopEvents: (_, { client }) => desktop.events(client.id),

      Sync: () => m.sync(),
      SyncState: () => m.syncState,
      Events: () => m.events,
    });
  }),
);

/** The RPC server the renderer talks to. Needs the Mailbox. */
export const RpcServerLive = RpcServer.layer(MailRpcs).pipe(
  Layer.provide(Handlers),
  Layer.provide(ElectronProtocol),
  Layer.provide(RpcSerialization.layerJson),
);
