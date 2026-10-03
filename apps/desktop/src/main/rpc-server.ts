import { checkNativeGrammar, nativeComposeCapabilities, pickNativeImages } from "./native-compose";
import { shareMessageLink } from "./share-message-link";
import { openExternal } from "./external";
import { trustedSender } from "./security";
import { decodeRpcFrame, publicRpcResponse } from "./rpc-security";
import { mailboxHandlers } from "../shared/mailbox-handlers";
import { desktopAppleContacts } from "./apple-contacts";
import { currentUpdateState } from "./update-state";
import { checkForUpdateState } from "./updates";
import { switchWindow } from "./window-keys";
import {
  attachmentAction,
  prepareAttachmentDrag,
  releaseAttachmentDrag,
} from "./attachment-actions";
import { clipboardAttachments } from "./clipboard-attachments";
import { diagnosticsPreview, hasCrashReport, dismissCrashReport } from "./reliability";
import { notificationActionCapabilities } from "../shared/desktop";
import { notificationPermission, openNotificationSettings } from "./notification-permission";
import { becomeDefaultClient, defaultClientStatus } from "./default-client";
import { IMAP_PRESETS, Mailbox, senderSearchQuery } from "@openmail/core";
import { Effect, FiberSet, Layer, Queue } from "effect";
import { RpcSerialization, RpcServer } from "effect/rpc";
import {
  BrowserWindow,
  clipboard,
  ipcMain,
  type IpcMainEvent,
  webContents,
  session,
} from "electron";

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
import {
  createMainWindow,
  openThreadWindow,
  openMessageWindow,
  openComposeWindow,
  approveComposeClose,
  retainComposeRecipients,
  takeComposeRecipients,
  claimInlineDraft,
  registerComposeDraft,
  setWindowSelection,
  windowOf,
} from "./windows";

/** Brings the app back to the front after a sign-in in the system browser. */
const focusApp = Effect.sync(() => BrowserWindow.getAllWindows()[0]?.focus());

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

        const onFrame = (event: IpcMainEvent, frame: unknown) => {
          if (!trustedSender(event)) return;
          const messages = decodeRpcFrame(frame);
          if (!messages) return;
          const client = event.sender;
          if (!clients.has(client.id)) {
            clients.add(client.id);
            client.once("destroyed", () => {
              clients.delete(client.id);
              run(Queue.offer(disconnects, client.id));
            });
          }
          run(
            Effect.forEach(messages, (message) => writeRequest(client.id, message), {
              discard: true,
            }),
          );
        };
        ipcMain.on(RPC_CHANNEL, onFrame);
        yield* Effect.addFinalizer(() => Effect.sync(() => ipcMain.off(RPC_CHANNEL, onFrame)));

        return {
          disconnects,
          send: (clientId, response) =>
            Effect.sync(() => {
              const frame = parser.encode(publicRpcResponse(response));
              const target = webContents.fromId(clientId);
              if (
                typeof frame === "string" &&
                target &&
                !target.isDestroyed() &&
                trustedSender({ sender: target, senderFrame: target.mainFrame })
              ) {
                target.send(RPC_CHANNEL, frame);
              }
            }),
          end: () => Effect.void,
          clientIds: Effect.sync(() => new Set(clients)),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
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
    const apple = desktopAppleContacts(m);
    return MailRpcs.of({
      ...mailboxHandlers(m),
      NotificationPermission: () => Effect.promise(() => notificationPermission()),
      RequestNotificationPermission: () => Effect.promise(() => notificationPermission(true)),
      OpenNotificationSettings: () => Effect.promise(openNotificationSettings),
      DefaultMailClient: () => Effect.sync(defaultClientStatus),
      BecomeDefaultMailClient: () => Effect.sync(becomeDefaultClient),

      NotificationActionCapabilities: () =>
        Effect.succeed(notificationActionCapabilities(process.platform)),
      Connect: ({ input }) => Effect.tap(m.connect(input), () => focusApp),
      Reauth: ({ accountId, feature }) => Effect.tap(m.reauth(accountId, feature), () => focusApp),
      ImapPresets: () => Effect.succeed(IMAP_PRESETS),
      AppleContactsStatus: () => apple.status,
      RefreshAppleContacts: () => apple.refresh(),
      SetAppleContacts: ({ enabled }) => apple.setEnabled(enabled),
      AppleContactIdentifier: ({ address }) => apple.identifier(address),
      OpenAppleContact: ({ address }) => apple.open(address),
      AddAppleContact: ({ contact }) => apple.add(contact),
      OpenAppleContactsSettings: () => apple.openSettings(),
      ContactGroups: ({ query, accountIds }) => apple.groups(query, accountIds),
      ContactPhoto: ({ accountId, address }) => apple.photo(accountId, address),
      SaveMessage: ({ id }, { client }) => saveMessage(m, windowOf(client.id), id),
      OpenMessageWeb: ({ id }) =>
        m.messageWebUrl(id).pipe(Effect.flatMap((url) => Effect.promise(() => openExternal(url)))),
      SearchSender: ({ address }) => desktop.search(senderSearchQuery(address)),
      AttachmentCapabilities: () => Effect.succeed({ share: process.platform === "darwin" }),
      ReleaseAttachmentDrag: (request, { client }) =>
        releaseAttachmentDrag(windowOf(client.id), request),
      PrepareAttachmentDrag: (request, { client }) =>
        prepareAttachmentDrag(m, windowOf(client.id), request),
      AttachmentAction: (request, { client }) => attachmentAction(m, windowOf(client.id), request),
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
      UpdateState: () => Effect.sync(currentUpdateState),
      CheckForUpdates: ({ download }) => checkForUpdateState(m, download),
      NativeComposeCapabilities: () => Effect.sync(() => nativeComposeCapabilities()),
      PickNativeImages: ({ kind, labels }, { client }) =>
        pickNativeImages(windowOf(client.id), kind, labels),
      CheckNativeGrammar: ({ text }, { client }) => checkNativeGrammar(windowOf(client.id), text),
      ShareMessageLink: (request, { client }) => shareMessageLink(m, windowOf(client.id), request),
      ClipboardAttachments: () => clipboardAttachments(),
      SetNativeMenuState: ({ state }, { client }) => desktop.setMenuState(client.id, state),
      SpellcheckLanguages: () =>
        Effect.sync(() => ({
          languages:
            process.platform === "darwin"
              ? []
              : session.defaultSession.availableSpellCheckerLanguages,
          automatic: process.platform === "darwin",
        })),
      SetPrefs: ({ patch }) => apple.setPrefs(patch),
      SuggestContacts: ({ query, exclude, accountIds }) =>
        apple.suggest(query, {
          ...(exclude === undefined ? {} : { exclude }),
          ...(accountIds === undefined ? {} : { accountIds }),
        }),
      ContactAlternatives: ({ address }) => apple.alternatives(address),
      SwitchWindow: ({ action }, { client }) => Effect.sync(() => switchWindow(client.id, action)),
      ClipboardText: () => Effect.promise(() => clipboard.readText()),
      ComposeNew: () => desktop.compose(),
      ComposeMessage: (input) => desktop.composeMessage({ _tag: "ComposeMessage", ...input }),
      OpenSettings: () => desktop.openSettings(),
      ClaimInlineDraft: ({ id }, { client }) =>
        Effect.sync(() => claimInlineDraft(windowOf(client.id), id)),
      OpenComposeWindow: ({ id, recipients, transfer }, { client }) =>
        m.openDraft(id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const win = openComposeWindow(
                id,
                undefined,
                transfer ? windowOf(client.id) : undefined,
              );
              if (recipients) retainComposeRecipients(win, recipients);
            }),
          ),
        ),
      ComposeWindowDraft: ({ id }, { client }) =>
        m.openDraft(id).pipe(
          Effect.map((draft) => {
            const win = windowOf(client.id);
            registerComposeDraft(win, draft.id);
            return { draft, recipients: takeComposeRecipients(win) };
          }),
        ),
      CloseComposeWindow: (_, { client }) =>
        Effect.sync(() => approveComposeClose(windowOf(client.id))),
      SetWindowSelection: ({ selection }, { client }) =>
        Effect.sync(() => setWindowSelection(windowOf(client.id), selection)),
      Diagnostics: ({ crashOnly }) => Effect.sync(() => diagnosticsPreview(crashOnly)),
      CrashReportPending: () => Effect.sync(hasCrashReport),
      DismissCrashReport: () => Effect.sync(dismissCrashReport),
      FeedbackAddress: () => Effect.succeed(process.env.OPENMAIL_FEEDBACK_ADDRESS ?? ""),
      NewWindow: () =>
        Effect.sync(() => {
          createMainWindow();
        }),
      CopyMessageLink: ({ id, kind }) =>
        m
          .privateMailLink(id, kind ?? "message")
          .pipe(Effect.flatMap((link) => Effect.promise(() => clipboard.writeText(link)))),
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
    });
  }),
);

/** The RPC server the renderer talks to. Needs the Mailbox. */
export const RpcServerLive = RpcServer.layer(MailRpcs).pipe(
  Layer.provide(Handlers),
  Layer.provide(ElectronProtocol),
  Layer.provide(RpcSerialization.layerJson),
);
