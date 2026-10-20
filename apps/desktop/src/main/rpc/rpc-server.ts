import { cleanLink, parseAppLink } from "@openmail/core/schema";
import { externalUrl } from "../../shared/external-url";
import { receiveAppUrl, Desktop } from "../system/system";
import {
  checkNativeGrammar,
  nativeComposeCapabilities,
  pickNativeImages,
} from "../system/native-compose";
import { shareMessageLink } from "../system/share-message-link";
import { openExternal } from "../security/external";
import { trustedSender } from "../security/security";
import {
  rpcFailureText,
  stringRpcServer,
  watchRpcClient,
  type StringTransport,
} from "./rpc-security";
import { mailboxHandlers } from "../../shared/mailbox-handlers";
import { desktopAppleContacts } from "../system/apple-contacts";
import { currentUpdateState } from "../updates/update-state";
import { checkForUpdateState } from "../updates/updates";
import { switchWindow } from "../windows/window-keys";
import {
  focusWindow,
  readClipboardText,
  showOpenDialog,
  writeClipboardText,
} from "../windows/reveal";
import { DEMO_DOWNLOADS, demoDownloads } from "../files/downloads-demo";
import {
  appDownloads,
  attachmentAction,
  attachmentApps,
  clearOpenedAttachments,
  openedAttachmentsUsage,
  prepareAttachmentDrag,
  removeAccountOpenedAttachments,
  releaseAttachmentDrag,
  saveAttachmentsTo,
} from "../files/attachment-actions";
import type { DownloadItem } from "../../shared/downloads";
import { textMenuCommand, popupWritingTools } from "../windows/spellcheck";
import { answerPrompt, windowUiEvents } from "../windows/window-ui";
import { clipboardAttachments } from "../files/clipboard-attachments";
import { chooseAttachmentFolder } from "../files/attachment-folder";
import { rendererPrefs } from "../../shared/renderer-prefs";
import {
  diagnosticsPreview,
  hasCrashReport,
  dismissCrashReport,
  localLog,
} from "../app/reliability";
import { notificationActionCapabilities } from "../../shared/desktop";
import {
  notificationPermission,
  openNotificationSettings,
} from "../system/notification-permission";
import { becomeDefaultClient, defaultClientStatus } from "../system/default-client";
import { diagnosticSnapshot, IMAP_PRESETS, Mailbox, senderSearchQuery } from "@openmail/core";
import { diagnosticEnvironment } from "../app/diagnostic-environment";
import { Effect, FiberSet, Layer, Queue, Stream } from "effect";
import { app, BrowserWindow, ipcMain, type IpcMainEvent, webContents, session } from "electron";

import { RPC_CHANNEL } from "../../shared/channel";
import { RemoteAccess } from "../remote/remote-access-live";
import { aiClientHandlers } from "../agents/ai-clients-rpc";
import { MailRpcs } from "../../shared/rpc";
import { printThread, saveMessage } from "../files/files";
import { openMeeting } from "../system/meeting";
import { setNativeLanguage } from "../app/native-i18n";
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
  setWindowRoute,
  windowOf,
} from "../windows/windows";

/** Brings the app back to the front after a sign-in in the system browser. */
const focusApp = Effect.sync(() => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) focusWindow(win);
});

/**
 * RPC server transport over Electron IPC. Each renderer (webContents) is one
 * client; its id is the client id. Frames are JSON strings.
 */
const electronTransport: StringTransport = {
  attach: (input) => {
    const watched = new Set<number>();
    const onFrame = (event: IpcMainEvent, frame: unknown) => {
      if (!trustedSender(event)) return;
      const client = event.sender;
      if (!input.frame(client.id, frame) || watched.has(client.id)) return;
      watched.add(client.id);
      watchRpcClient(
        client,
        () => input.disconnect(client.id),
        () => watched.delete(client.id),
      );
    };
    ipcMain.on(RPC_CHANNEL, onFrame);
    return () => ipcMain.off(RPC_CHANNEL, onFrame);
  },
  send: (clientId, frame) => {
    const target = webContents.fromId(clientId);
    if (
      target &&
      !target.isDestroyed() &&
      trustedSender({ sender: target, senderFrame: target.mainFrame })
    )
      target.send(RPC_CHANNEL, frame);
  },
  failure: (failure) => {
    localLog("rpc-failure", failure);
    process.stderr.write(`[rpc-failure] ${rpcFailureText(failure)}\n`);
  },
};

const Handlers = MailRpcs.toLayer(
  Effect.gen(function* () {
    const m = yield* Mailbox;
    const desktop = yield* Desktop;
    const remote = yield* RemoteAccess;
    const apple = desktopAppleContacts(m);
    const downloads = appDownloads(m, yield* FiberSet.makeRuntime());
    // The browser page after sign-in follows the language setting.
    const signInLanguage = m.app.prefs.pipe(
      Effect.tap((prefs) => Effect.sync(() => setNativeLanguage(prefs.language))),
      Effect.ignore,
    );
    const handlers = mailboxHandlers(m, { contacts: apple });
    return MailRpcs.of({
      ...handlers,
      // Removing an account also deletes its opened attachment copies that nobody edited.
      RemoveAccount: (request) =>
        handlers
          .RemoveAccount(request)
          .pipe(Effect.tap(() => removeAccountOpenedAttachments(request.accountId))),
      NotificationPermission: () => Effect.promise(() => notificationPermission()),
      RequestNotificationPermission: () => Effect.promise(() => notificationPermission(true)),
      OpenNotificationSettings: () => Effect.promise(openNotificationSettings),
      DefaultMailClient: () => Effect.sync(defaultClientStatus),
      BecomeDefaultMailClient: () => Effect.sync(becomeDefaultClient),

      NotificationActionCapabilities: () =>
        Effect.succeed(notificationActionCapabilities(process.platform)),
      Connect: ({ input }) =>
        signInLanguage.pipe(
          Effect.andThen(m.accounts.connect(input)),
          Effect.tap(() => focusApp),
        ),
      Reauth: ({ accountId, feature }) =>
        signInLanguage.pipe(
          Effect.andThen(m.accounts.reauth(accountId, feature)),
          Effect.tap(() => focusApp),
        ),
      ImapPresets: () => Effect.succeed(IMAP_PRESETS),
      AppleContactsStatus: () => apple.status,
      RefreshAppleContacts: () => apple.refresh(),
      SetAppleContacts: ({ enabled }) => apple.setEnabled(enabled),
      AppleContactIdentifier: ({ address }) => apple.identifier(address),
      OpenAppleContact: ({ address }) => apple.open(address),
      AddAppleContact: ({ contact }) => apple.add(contact),
      OpenAppleContactsSettings: () => apple.openSettings(),
      SaveMessage: ({ id }, { client }) => saveMessage(m, windowOf(client.id), id),
      OpenMessageWeb: ({ id }) =>
        Effect.gen(function* () {
          const prefs = yield* m.app.prefs;
          const url = yield* m.reading.messageWebUrl(id);
          yield* Effect.promise(() => openExternal(url, prefs.cleanLinks !== false));
        }),
      SearchSender: ({ address }) => desktop.search(senderSearchQuery(address)),
      AttachmentCapabilities: () => Effect.succeed({ share: process.platform === "darwin" }),
      ReleaseAttachmentDrag: (request, { client }) =>
        releaseAttachmentDrag(windowOf(client.id), request),
      PrepareAttachmentDrag: (request, { client }) =>
        prepareAttachmentDrag(m, windowOf(client.id), request),
      AttachmentAction: (request, { client }) =>
        attachmentAction(m, windowOf(client.id), request, downloads),
      SaveAttachmentsTo: (request, { client }) =>
        saveAttachmentsTo(m, downloads, windowOf(client.id), request),
      AttachmentApps: (request) => attachmentApps(m, request),
      OpenedAttachmentsUsage: openedAttachmentsUsage,
      ClearOpenedAttachments: clearOpenedAttachments,
      Downloads: () =>
        demoDownloads(app.isPackaged, process.env)
          ? Stream.concat(Stream.make(DEMO_DOWNLOADS), Stream.never)
          : Stream.callback<readonly DownloadItem[]>((queue) =>
              Effect.gen(function* () {
                Queue.offerUnsafe(queue, downloads.list());
                const off = downloads.subscribe((items) => {
                  Queue.offerUnsafe(queue, items);
                });
                yield* Effect.addFinalizer(() => Effect.sync(off));
                yield* Effect.never;
              }),
            ),
      DownloadAction: ({ id, command }) => downloads.command(id, command),
      ClearDownloads: () => Effect.sync(() => downloads.clear()),
      WindowUiEvents: (_, { client }) => windowUiEvents(client.id),
      AnswerPrompt: ({ id, answer }, { client }) =>
        Effect.sync(() => answerPrompt(client.id, id, answer)),
      TextMenuCommand: ({ command }, { client }) =>
        Effect.sync(() => {
          const win = windowOf(client.id);
          textMenuCommand(win, command, (state) => {
            if (win) popupWritingTools(win, state);
          });
        }),
      PrintThread: (request, { client }) => printThread(m, windowOf(client.id), request),
      OpenThreadWindow: ({ id }, { client }) =>
        Effect.sync(() => {
          openThreadWindow(id, windowOf(client.id));
        }),
      OpenMessageWindow: ({ id }, { client }) =>
        Effect.sync(() => {
          openMessageWindow(id, windowOf(client.id));
        }),
      OpenMeeting: ({ url }) =>
        m.app.prefs.pipe(Effect.flatMap((prefs) => openMeeting(url, prefs.cleanLinks !== false))),
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
      SetPrefs: ({ patch }) => rendererPrefs(patch).pipe(Effect.flatMap(apple.setPrefs)),
      ChooseAttachmentFolder: (_, { client }) =>
        chooseAttachmentFolder(m, (options) => {
          const parent = windowOf(client.id);
          return showOpenDialog(parent, options);
        }),
      SwitchWindow: ({ action }, { client }) => Effect.sync(() => switchWindow(client.id, action)),
      ClipboardText: () => Effect.promise(() => readClipboardText()),
      CopyText: ({ text }) => Effect.promise(() => writeClipboardText(text)),
      OpenMailLink: ({ url }) =>
        Effect.gen(function* () {
          const target = externalUrl(url);
          if (!target) return;
          if (new URL(target).protocol === "mailto:") {
            if (parseAppLink(target)?.kind === "compose") receiveAppUrl(target);
            return;
          }
          const prefs = yield* m.app.prefs;
          yield* Effect.promise(() =>
            openExternal(cleanLink(target, prefs.cleanLinks !== false), false),
          );
        }),
      ComposeNew: () => desktop.compose(),
      ComposeMessage: (input) => desktop.composeMessage({ _tag: "ComposeMessage", ...input }),
      ShowUndo: (input) => desktop.showUndo({ _tag: "ShowUndo", ...input }),
      OpenSettings: () => desktop.openSettings(),
      ClaimInlineDraft: ({ id }, { client }) =>
        Effect.sync(() => claimInlineDraft(windowOf(client.id), id)),
      OpenComposeWindow: ({ id, recipients, transfer }, { client }) =>
        m.compose.openDraft(id).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const parent = windowOf(client.id);
              const win = openComposeWindow(id, undefined, transfer ? parent : undefined, parent);
              if (recipients) retainComposeRecipients(win, recipients);
            }),
          ),
        ),
      ComposeWindowDraft: ({ id }, { client }) =>
        m.compose.openDraft(id).pipe(
          Effect.map((draft) => {
            const win = windowOf(client.id);
            registerComposeDraft(win, draft.id);
            return { draft, recipients: takeComposeRecipients(win) };
          }),
        ),
      CloseComposeWindow: (_, { client }) =>
        m.outbox
          .cancelDesktopUndoSends(String(client.id))
          .pipe(Effect.andThen(Effect.sync(() => approveComposeClose(windowOf(client.id))))),
      SetWindowRoute: ({ href }, { client }) =>
        Effect.sync(() => setWindowRoute(windowOf(client.id), href)),
      Diagnostics: ({ crashOnly }) =>
        Effect.all([m.app.diagnosticsState, m.accounts.accounts]).pipe(
          // A broken database must not hide the rest of the report.
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.map((loaded) =>
            diagnosticsPreview(
              crashOnly,
              diagnosticSnapshot(diagnosticEnvironment(), loaded?.[0]),
              // Records name accounts by the snapshot's index, never by hash.
              loaded?.[1].map((account) => account.id),
            ),
          ),
        ),
      CrashReportPending: () => Effect.sync(hasCrashReport),
      DismissCrashReport: () => Effect.sync(dismissCrashReport),
      FeedbackAddress: () => Effect.succeed(process.env.OPENMAIL_FEEDBACK_ADDRESS ?? ""),
      NewWindow: () =>
        Effect.sync(() => {
          createMainWindow();
        }),
      CopyMessageLink: ({ id, kind }) =>
        (kind === "web"
          ? m.reading.messageWebUrl(id)
          : m.reading.privateMailLink(id, kind ?? "message")
        ).pipe(Effect.flatMap((link) => Effect.promise(() => writeClipboardText(link)))),
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
      ...aiClientHandlers(m),
      RemoteAccess: () => remote.view,
      RefreshRemoteAccess: () => remote.refresh,
      SetRemoteAccess: ({ enabled }) => remote.setEnabled(enabled),
      SetRemoteAllowlist: ({ logins }) => remote.setAllowlist(logins),
      SetRemoteService: ({ service }) => remote.setService(service),
      DisconnectRemoteSession: ({ id }) => remote.disconnect(id),
    });
  }),
);

/** The RPC server the renderer talks to. Needs the Mailbox. */
export const RpcServerLive = stringRpcServer(MailRpcs, electronTransport).pipe(
  Layer.provide(Handlers),
);
