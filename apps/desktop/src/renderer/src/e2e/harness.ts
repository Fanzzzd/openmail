import type { NativePickerResult } from "../../../shared/native-compose";
import { stringRpcServer } from "../../../main/rpc/rpc-security";
import { RegistryContext } from "@effect/atom-react";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  IMAP_PRESETS,
  Mailbox,
  type Account,
  type IncomingMessage,
  type Provider,
  type PrefsPatch,
  type NotificationBatch,
  type OutgoingMessage,
} from "@openmail/core/portable";
import {
  Store,
  fakeServer,
  type FakeServer,
  TemporaryTestMailbox,
} from "@openmail/core/testing/node";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react/pure";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { AtomRegistry } from "effect/reactivity";
import type { Rpc, RpcGroup, RpcMessage } from "effect/rpc";
import { createMemoryHistory } from "@tanstack/react-router";
import { createElement } from "react";
import { vi } from "vitest";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";
import type { RpcBridge } from "../../../shared/channel";
import type { DesktopEvent } from "../../../shared/desktop";
import { mailboxHandlers } from "../../../shared/mailbox-handlers";
import { rendererPrefs } from "../../../shared/renderer-prefs";
import { MailRpcs } from "../../../shared/rpc";
import { AiClientError } from "../../../shared/ai-clients";
import { type AppRouter, createAppRouter, historyFor, initialLocation } from "../routes/router";
import { createAppHashHistory } from "../routes/hash-history";
import { AppRouterProvider } from "../routes/provider";
import { historyAtom, locationAtom } from "../state/location";
import { composeHref, DEFAULT_VIEW, mailHref, threadHref } from "../../../shared/routes";
import { TipProvider } from "../ui/Tip";
import { lazyLoads } from "./lazy-loads";

const unsupported = () => Effect.die(new Error("Unexpected desktop operation in flow test"));

// Capture the real timer before tests replace debounce/undo timers.
const schedulerTimeout = globalThis.setTimeout;
const now = performance.now.bind(performance);
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    schedulerTimeout(resolve, ms);
  });

/**
 * The last time the app did observable work: a DOM change or an RPC frame either way. On a
 * loaded machine a render or a reply can take seconds, so `eventually` waits for the app to go
 * quiet rather than for a fixed time.
 */
let lastProgress = now();
const progress = () => {
  lastProgress = now();
};
new MutationObserver(progress).observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
});
const quietMs = scaledMs(2500);

/**
 * Wait on real scheduler turns even when the UI's debounce/undo timers are virtual. Fails once
 * the check has failed and the app has made no progress for `quietMs`, or after three times that
 * in all, so a check that can never pass reports its own failure before the test timeout.
 */
export async function eventually(check: () => void | Promise<void>) {
  const start = now();
  lastProgress = start;
  let failure: unknown;
  for (;;) {
    try {
      await act(async () => {
        await check();
      });
      return;
    } catch (error) {
      failure = error;
    }
    await act(async () => {
      await pause(5);
    });
    const at = now();
    if (at - lastProgress > quietMs || at - start > 3 * quietMs) throw failure;
  }
}

/** Lets the app run for `ms` of real time, for checks that something does not happen. */
export async function wait(ms: number) {
  await act(async () => {
    await pause(ms);
  });
}

export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export function incoming(
  providerId: string,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    providerId,
    threadId: `t-${providerId}`,
    subject: `Flow ${providerId}`,
    from: { name: "Alice", address: "alice@example.com" },
    to: [{ name: "Me", address: "me@gmail.com" }],
    cc: [{ name: "Bob", address: "bob@example.com" }],
    date: Date.now() - (providerId === "one" ? 1000 : 2000),
    snippet: `Original ${providerId}`,
    bodyText: `Original ${providerId}`,
    bodyHtml: "",
    labels: ["INBOX", "UNREAD"],
    attachments: [],
    isUnread: true,
    isStarred: false,
    ...overrides,
  };
}

type MailRpc = RpcGroup.Rpcs<typeof MailRpcs>;
type HandlerOverrides = {
  readonly [Current in MailRpc as Current["_tag"]]?: Rpc.ToHandlerFn<Current, never>;
};

interface FlowHarness {
  server: FakeServer;
  m: Mailbox["Service"];
  store: Store["Service"];
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  requests: RpcMessage.RequestEncoded[];
  responses: RpcMessage.FromServerEncoded[];
  account: Account;
  notifications: NotificationBatch[];
  id(id: string): string;
  event(event: DesktopEvent): Promise<void>;
  holdLists(): Promise<() => Promise<void>>;
  /** Answers the held Prefs requests; see the `holdPrefs` option. */
  releasePrefs(): Promise<void>;
  /** The draft the compose window opened with, if any. */
  composeId: string | undefined;
  /** The window's router, on memory history. */
  router: AppRouter;
  /** The current route href, as the history holds it. */
  href(): string;
  dispose(): Promise<void>;
}

export async function flow(
  options: {
    provider?: Provider;
    messages?: IncomingMessage[];
    prefs?: PrefsPatch;
    agentDraft?: { message: OutgoingMessage; surface: "mcp" | "rule" | "assistant" };
    /**
     * Saves this draft through the real draft store and opens it in the compose window. With
     * `failPush` its first push fails, so it opens as never synced.
     */
    storedDraft?: { message: OutgoingMessage; failPush?: FakeServer["failNext"] };
    /** Opens a server draft in the compose window through the real import path. */
    serverDraft?: { providerId: string; raw: Uint8Array };
    native?: {
      pick: () => NativePickerResult;
      share: (request: { id: string; kind: "message" | "thread" | "web" }) => void;
    };
    /** Renders the thread window for this message instead of the main window. */
    thread?: string;
    /** The main window's starting route, from shared/routes. */
    route?: string;
    /**
     * Routes through jsdom's window history the way the app does, instead of memory history.
     * Browser history queues its writes until a microtask, which memory history does not.
     */
    windowHistory?: boolean;
    /** The renderer sees no accounts, as on first launch. */
    noAccounts?: boolean;
    /** Prefs requests wait until `releasePrefs`, as on a slow first load. */
    holdPrefs?: boolean;
    /** Replaces these main-process handlers, after every other option. */
    handlers?: HandlerOverrides;
  } = {},
): Promise<FlowHarness> {
  const provider = options.provider ?? "gmail";
  const email = `me@${provider === "gmail" ? "gmail.com" : provider === "outlook" ? "outlook.com" : "example.com"}`;
  const messages = options.messages ?? [incoming("one"), incoming("two")];
  const server = fakeServer(email, messages);
  server.labels = [{ id: provider === "gmail" ? "Label_work" : "work", name: "Work", color: null }];
  const mailboxRuntime = ManagedRuntime.make(TemporaryTestMailbox({ [provider]: server }));
  const m = await mailboxRuntime.runPromise(Mailbox);
  const store = await mailboxRuntime.runPromise(Store);
  const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => mailboxRuntime.runPromise(effect);
  const account = await run(
    m.accounts.connect(
      provider === "imap"
        ? {
            provider,
            input: {
              preset: "custom",
              email,
              password: "fake-password",
              imapHost: "imap.example.com",
              imapPort: 993,
              smtpHost: "smtp.example.com",
              smtpPort: 465,
            },
          }
        : { provider },
    ),
  );
  await run(
    m.app.setPrefs({
      language: "en",
      markReadDelay: "manual",
      undoSendSeconds: 0,
      defaultProfilesPrompted: true,
      remoteImages: "ask",
      ...options.prefs,
    }),
  );
  // Connect starts a detached sync. Drain it before exposing the renderer to the fixture.
  await run(m.sync.sync());
  await Promise.all(lazyLoads);

  let composeId: string | undefined;
  if (options.serverDraft) {
    server.raw.set(options.serverDraft.providerId, options.serverDraft.raw);
    composeId = (await run(m.compose.openDraft(`${account.id}/${options.serverDraft.providerId}`)))
      .id;
  }
  if (options.storedDraft) {
    server.failNext = options.storedDraft.failPush;
    composeId = (
      await run(
        m.compose.saveDraft({
          id: `draft:${crypto.randomUUID()}`,
          accountId: account.id,
          message: options.storedDraft.message,
        }),
      )
    ).id;
  }
  if (options.agentDraft) {
    await run(m.proposals.setAgentWriteMode("propose"));
    const outcome = await run(
      m.organize.perform(
        { kind: "draft", accountId: account.id, message: options.agentDraft.message },
        {
          kind: "agent",
          surface: options.agentDraft.surface,
          name: options.agentDraft.surface === "mcp" ? "Flow agent" : "openmail-assistant",
        },
      ),
    );
    if (outcome.status !== "proposed") throw new Error("Agent draft was not proposed");
    composeId = (await run(m.compose.openDraft(`proposal:${outcome.proposalId}`))).id;
  }
  const desktop = await Effect.runPromise(PubSub.unbounded<DesktopEvent>());
  const desktopReady = await Effect.runPromise(Deferred.make<void>());
  const notificationReady = await Effect.runPromise(Deferred.make<void>());
  const notifications: NotificationBatch[] = [];
  const notificationFiber = mailboxRuntime.runFork(
    m.app.events.pipe(
      Stream.onStart(Deferred.succeed(notificationReady, undefined)),
      Stream.runForEach((event) =>
        event._tag === "NewMail"
          ? m.app.takeNotifications.pipe(
              Effect.tap((batches) => Effect.sync(() => notifications.push(...batches))),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    ),
  );
  await run(Deferred.await(notificationReady));
  const requests: RpcMessage.RequestEncoded[] = [];
  const responses: RpcMessage.FromServerEncoded[] = [];
  const listeners = new Set<(frame: string) => void>();
  const bridge: RpcBridge = {
    send: () => {
      throw new Error("RPC server is not ready");
    },
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  window.openmailRpc = bridge;
  let listWait: Effect.Effect<void> = Effect.void;
  const prefsReady = await Effect.runPromise(Deferred.make<void>());
  if (!options.holdPrefs) await Effect.runPromise(Deferred.succeed(prefsReady, undefined));
  const coreHandlers = mailboxHandlers(m);
  const handlers = MailRpcs.toLayer(
    MailRpcs.of({
      ...coreHandlers,
      QueueUndoSend: ({ draft, due, archive, confirmResend }, { client }) =>
        m.outbox.queueUndoSend(draft, due, { archive, confirmResend, owner: String(client.id) }),
      Threads: (input) =>
        Effect.andThen(
          Effect.suspend(() => listWait),
          coreHandlers.Threads(input),
        ),
      Prefs: () => Effect.andThen(Deferred.await(prefsReady), coreHandlers.Prefs()),
      NotificationActionCapabilities: unsupported,
      SetAppleContacts: unsupported,
      OpenAppleContact: unsupported,
      AddAppleContact: unsupported,
      OpenAppleContactsSettings: unsupported,
      SaveMessage: unsupported,
      // The main process opens a browser or a window; the request itself is what flows check.
      OpenMessageWeb: () => Effect.void,
      SearchSender: unsupported,
      ReleaseAttachmentDrag: unsupported,
      PrepareAttachmentDrag: unsupported,
      AttachmentAction: unsupported,
      SaveAttachmentsTo: unsupported,
      AttachmentApps: unsupported,
      Downloads: () => Stream.make([]),
      DownloadAction: unsupported,
      ClearDownloads: () => Effect.void,
      OpenedAttachmentsUsage: () => Effect.succeed({ bytes: 0, copies: 0, edited: 0 }),
      ClearOpenedAttachments: () => Effect.succeed({ bytes: 0, copies: 0, edited: 0 }),
      WindowUiEvents: () => Stream.never,
      AnswerPrompt: () => Effect.void,
      TextMenuCommand: () => Effect.void,
      PrintThread: unsupported,
      OpenThreadWindow: unsupported,
      OpenMessageWindow: unsupported,
      OpenMeeting: unsupported,
      CheckForUpdates: unsupported,
      SwitchWindow: unsupported,
      ClipboardText: unsupported,
      OpenSettings: () => Effect.void,
      OpenComposeWindow: unsupported,
      ComposeWindowDraft: ({ id }) =>
        m.compose.openDraft(id).pipe(Effect.map((draft) => ({ draft, recipients: null }))),
      CloseComposeWindow: unsupported,
      Diagnostics: unsupported,
      DismissCrashReport: unsupported,
      FeedbackAddress: unsupported,
      NewWindow: () => Effect.void,
      NativeComposeCapabilities: () =>
        Effect.succeed({
          photos: Boolean(options.native),
          continuity: Boolean(options.native),
          grammar: false,
        }),
      PickNativeImages: () => (options.native ? Effect.sync(options.native.pick) : unsupported()),
      CheckNativeGrammar: unsupported,
      ShareMessageLink: (request) =>
        options.native ? Effect.sync(() => options.native?.share(request)) : unsupported(),
      CopyMessageLink: unsupported,
      NativeEdit: unsupported,
      NotificationPermission: () => Effect.succeed("unsupported"),
      RequestNotificationPermission: unsupported,
      OpenNotificationSettings: unsupported,
      DefaultMailClient: () => Effect.succeed({ available: false, isDefault: false }),
      BecomeDefaultMailClient: unsupported,
      Connect: ({ input }) => m.accounts.connect(input),
      SetClassificationOverride: ({ messageId, classifyAs }) =>
        m.organize.setClassificationOverride(messageId, classifyAs),
      Reauth: ({ accountId, feature }) => m.accounts.reauth(accountId, feature),
      ImapPresets: () => Effect.succeed(IMAP_PRESETS),
      AppleContactsStatus: () => Effect.succeed({ status: "off", revision: 0 }),
      RefreshAppleContacts: () => Effect.succeed({ status: "off", revision: 0 }),
      AppleContactIdentifier: () => Effect.succeed(null),
      ContactGroups: ({ query, accountIds }) => m.contacts.contactGroups(query, accountIds),
      ContactPhoto: ({ accountId, address }) => m.contacts.contactPhoto(accountId, address),
      AttachmentCapabilities: () => Effect.succeed({ share: Boolean(options.native) }),
      UpdateState: () => Effect.succeed({ status: "disabled" }),
      ...(options.noAccounts ? { Accounts: () => Effect.succeed([]) } : {}),
      ClipboardAttachments: () => Effect.succeed([]),
      SetNativeMenuState: () => Effect.void,
      SpellcheckLanguages: () => Effect.succeed({ languages: [], automatic: true }),
      SetPrefs: ({ patch }) =>
        rendererPrefs(patch).pipe(Effect.flatMap((value) => m.app.setPrefs(value))),
      ChooseAttachmentFolder: unsupported,
      SuggestContacts: ({ query, exclude, accountIds }) =>
        m.contacts.suggestContacts(query, { exclude, accountIds }),
      ContactAlternatives: ({ address }) => m.contacts.contactAlternatives(address),
      ImportCalendarAttachment: unsupported,
      InspectAttachment: unsupported,
      Unsubscribe: unsupported,
      OpenMailLink: unsupported,
      ShowUndo: (input) =>
        PubSub.publish(desktop, { _tag: "ShowUndo", ...input }).pipe(Effect.asVoid),
      ComposeNew: () =>
        PubSub.publish(desktop, { _tag: "Command", command: "compose" }).pipe(Effect.asVoid),
      ComposeMessage: (input) =>
        PubSub.publish(desktop, { _tag: "ComposeMessage", ...input }).pipe(Effect.asVoid),
      ClaimInlineDraft: () => Effect.succeed(true),
      SetWindowRoute: () => Effect.void,
      CrashReportPending: () => Effect.succeed(false),
      SetActiveSpace: () => Effect.void,
      SetSendState: () => Effect.void,
      SetDesktopLabels: () => Effect.void,
      RemoteAccess: () =>
        Stream.concat(
          Stream.make({
            enabled: false,
            allowlist: [],
            service: "",
            tailscale: {
              installed: false,
              running: false,
              tailnet: null,
              dnsName: null,
              suffix: null,
              login: null,
              https: false,
            },
            status: "off" as const,
            problem: null,
            url: null,
            sessions: [],
          }),
          Stream.never,
        ),
      RefreshRemoteAccess: () => Effect.void,
      AiClients: () =>
        Effect.map(m.proposals.agentActivity(200), (activity) => ({
          launch: {
            command: "/Applications/OpenMail.app/Contents/MacOS/OpenMail",
            args: ["--mcp"],
            env: {},
          },
          launchProblem: null,
          clients: [],
          activity,
        })),
      PreviewAiClientChange: () =>
        Effect.fail(new AiClientError({ reason: "notInstalled", detail: "" })),
      ApplyAiClientChange: () =>
        Effect.fail(new AiClientError({ reason: "notInstalled", detail: "" })),
      SetRemoteAccess: unsupported,
      SetRemoteAllowlist: unsupported,
      SetRemoteService: unsupported,
      DisconnectRemoteSession: unsupported,
      DesktopEvents: () =>
        Stream.fromPubSub(desktop).pipe(Stream.onStart(Deferred.succeed(desktopReady, undefined))),
      ...options.handlers,
    }),
  );
  // The app's own server and protocol, over an in-memory pipe for one window.
  const rpcRuntime = ManagedRuntime.make(
    stringRpcServer(MailRpcs, {
      attach: (input) => {
        bridge.send = (frame) => {
          progress();
          // Electron IPC delivers on a later turn, including short-lived key clients.
          queueMicrotask(() => input.frame(1, frame));
        };
        return () => {
          bridge.send = () => null;
        };
      },
      inspect: (_, batch) => {
        for (const message of batch) if (message._tag === "Request") requests.push(message);
      },
      send: (_, frame) => {
        progress();
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- IO boundary: the frame the server just encoded.
        responses.push(JSON.parse(frame) as RpcMessage.FromServerEncoded);
        queueMicrotask(() => {
          for (const listener of listeners) listener(frame);
        });
      },
      failure: () => null,
    }).pipe(Layer.provide(handlers)),
  );
  await rpcRuntime.runPromise(Effect.void);
  const registry = AtomRegistry.make();
  const startHref = options.thread
    ? threadHref(`${account.id}/${options.thread}`)
    : composeId
      ? composeHref(composeId)
      : (options.route ?? mailHref(DEFAULT_VIEW));
  if (options.windowHistory) window.history.replaceState(null, "", `#${startHref}`);
  const router = createAppRouter(
    options.windowHistory
      ? createAppHashHistory(window)
      : createMemoryHistory({ initialEntries: [startHref] }),
  );
  await router.load();
  registry.set(locationAtom, initialLocation(router));
  registry.set(historyAtom, historyFor(router));
  // The app renders with the global instance, which core macros such as plural() read too.
  i18n.loadAndActivate({ locale: "en", messages: {} });
  render(
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(
        I18nProvider,
        { i18n },
        createElement(TipProvider, null, createElement(AppRouterProvider, { router })),
      ),
    ),
  );
  await rpcRuntime.runPromise(Deferred.await(desktopReady));
  return {
    server,
    m,
    store,
    run,
    requests,
    responses,
    account,
    notifications,
    id: (id: string) => `${account.id}/${id}`,
    composeId,
    router,
    href: () => `${router.history.location.pathname}${router.history.location.search}`,
    async event(event: DesktopEvent) {
      await act(async () => {
        await Effect.runPromise(PubSub.publish(desktop, event));
      });
    },
    async releasePrefs() {
      await act(async () => {
        await Effect.runPromise(Deferred.succeed(prefsReady, undefined));
      });
    },
    async holdLists() {
      const ready = await Effect.runPromise(Deferred.make<void>());
      listWait = Deferred.await(ready);
      return async () => {
        listWait = Effect.void;
        await Effect.runPromise(Deferred.succeed(ready, undefined));
      };
    },
    async dispose() {
      // A selection's history replace waits to settle; write it out while the window still
      // exists, or its timer lands on a torn-down window in the next test.
      registry.get(historyAtom).flush();
      await Promise.resolve();
      cleanup();
      registry.dispose();
      router.history.destroy();
      vi.useRealTimers();
      await Effect.runPromise(Fiber.interrupt(notificationFiber));
      await rpcRuntime.dispose();
      await Effect.runPromise(PubSub.shutdown(desktop));
      await mailboxRuntime.dispose();
      vi.restoreAllMocks();
    },
  };
}

export function row(id: string) {
  const element = document.querySelector(`[data-id="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing message row ${id}`);
  return element;
}
export function clickButton(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}
export function key(
  stroke: string,
  options: { metaKey?: boolean; shiftKey?: boolean; ctrlKey?: boolean } = {},
  target: EventTarget = document.activeElement ?? window,
) {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key: stroke,
    ...options,
  });
  act(() => {
    target.dispatchEvent(event);
  });
}
