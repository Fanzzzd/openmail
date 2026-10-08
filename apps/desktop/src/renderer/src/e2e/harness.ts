import type { NativePickerResult } from "../../../shared/native-compose";
import { decodeRpcFrame, publicRpcResponse } from "../../../main/rpc-security";
import { RegistryContext } from "@effect/atom-react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  IMAP_PRESETS,
  Mailbox,
  type Account,
  type IncomingMessage,
  type Provider,
  type Prefs,
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
import {
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Layer,
  ManagedRuntime,
  PubSub,
  Queue,
  Stream,
} from "effect";
import { AtomRegistry } from "effect/reactivity";
import { RpcMessage, RpcSerialization, RpcServer } from "effect/rpc";
import { createElement } from "react";
import { vi } from "vitest";
import type { RpcBridge } from "../../../shared/channel";
import type { DesktopEvent } from "../../../shared/desktop";
import { mailboxHandlers } from "../../../shared/mailbox-handlers";
import { MailRpcs } from "../../../shared/rpc";
import { App } from "../App";
import { ThreadWindow } from "../ThreadWindow";
import { TipProvider } from "../components/ui/Tip";

const unsupported = () => Effect.die(new Error("Unexpected desktop operation in flow test"));

// Capture the real timer before tests replace debounce/undo timers.
const schedulerTimeout = globalThis.setTimeout;
const pause = (ms: number) =>
  new Promise<void>((resolve) => {
    schedulerTimeout(resolve, ms);
  });

/** Wait on real scheduler turns even when the UI's debounce/undo timers are virtual. */
export async function eventually(check: () => void | Promise<void>) {
  const deadline = performance.now() + 2500;
  let failure: unknown;
  do {
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
  } while (performance.now() < deadline);
  throw failure;
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
  dispose(): Promise<void>;
}

export async function flow(
  options: {
    provider?: Provider;
    messages?: IncomingMessage[];
    prefs?: Partial<Prefs>;
    agentDraft?: { message: OutgoingMessage; surface: "mcp" | "rule" | "assistant" };
    /** Opens a server draft in the compose window through the real import path. */
    serverDraft?: { providerId: string; raw: Uint8Array };
    native?: {
      pick: () => NativePickerResult;
      share: (request: { id: string; kind: "message" | "thread" | "web" }) => void;
    };
    /** Renders the thread window for this message instead of the main window. */
    thread?: string;
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
    m.connect(
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
    m.setPrefs({
      language: "en",
      markReadDelay: "manual",
      undoSendSeconds: 0,
      defaultProfilesPrompted: true,
      ...options.prefs,
    }),
  );
  // Connect starts a detached sync. Drain it before exposing the renderer to the fixture.
  await run(m.sync());

  let composeId: string | undefined;
  if (options.serverDraft) {
    server.raw.set(options.serverDraft.providerId, options.serverDraft.raw);
    composeId = (await run(m.openDraft(`${account.id}/${options.serverDraft.providerId}`))).id;
  }
  if (options.agentDraft) {
    await run(m.setAgentWriteMode("propose"));
    const outcome = await run(
      m.perform(
        { kind: "draft", accountId: account.id, message: options.agentDraft.message },
        {
          kind: "agent",
          surface: options.agentDraft.surface,
          name: options.agentDraft.surface === "mcp" ? "Flow agent" : "openmail-assistant",
        },
      ),
    );
    if (outcome.status !== "proposed") throw new Error("Agent draft was not proposed");
    composeId = (await run(m.openDraft(`proposal:${outcome.proposalId}`))).id;
  }
  const desktop = await Effect.runPromise(PubSub.unbounded<DesktopEvent>());
  const desktopReady = await Effect.runPromise(Deferred.make<void>());
  const notificationReady = await Effect.runPromise(Deferred.make<void>());
  const notifications: NotificationBatch[] = [];
  const notificationFiber = mailboxRuntime.runFork(
    m.events.pipe(
      Stream.onStart(Deferred.succeed(notificationReady, undefined)),
      Stream.runForEach((event) =>
        event._tag === "NewMail"
          ? m.takeNotifications.pipe(
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
  const coreHandlers = mailboxHandlers(m);
  const handlers = MailRpcs.toLayer(
    MailRpcs.of({
      ...coreHandlers,
      QueueUndoSend: ({ draft, due, archive, confirmResend }, { client }) =>
        m.queueUndoSend(draft, due, { archive, confirmResend, owner: String(client.id) }),
      Threads: (input) =>
        Effect.andThen(
          Effect.suspend(() => listWait),
          coreHandlers.Threads(input),
        ),
      NotificationActionCapabilities: unsupported,
      SetAppleContacts: unsupported,
      OpenAppleContact: unsupported,
      AddAppleContact: unsupported,
      OpenAppleContactsSettings: unsupported,
      SaveMessage: unsupported,
      OpenMessageWeb: unsupported,
      SearchSender: unsupported,
      ReleaseAttachmentDrag: unsupported,
      PrepareAttachmentDrag: unsupported,
      AttachmentAction: unsupported,
      SaveAttachment: unsupported,
      OpenAttachment: unsupported,
      SaveAllAttachments: unsupported,
      PrintThread: unsupported,
      OpenThreadWindow: unsupported,
      OpenMessageWindow: unsupported,
      OpenMeeting: unsupported,
      CheckForUpdates: unsupported,
      SwitchWindow: unsupported,
      ClipboardText: unsupported,
      OpenSettings: unsupported,
      OpenComposeWindow: unsupported,
      ComposeWindowDraft: ({ id }) =>
        m.openDraft(id).pipe(Effect.map((draft) => ({ draft, recipients: null }))),
      CloseComposeWindow: unsupported,
      Diagnostics: unsupported,
      DismissCrashReport: unsupported,
      FeedbackAddress: unsupported,
      NewWindow: unsupported,
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
      Connect: ({ input }) => m.connect(input),
      SetClassificationOverride: ({ messageId, classifyAs }) =>
        m.setClassificationOverride(messageId, classifyAs),
      Reauth: ({ accountId, feature }) => m.reauth(accountId, feature),
      ImapPresets: () => Effect.succeed(IMAP_PRESETS),
      AppleContactsStatus: () => Effect.succeed({ status: "off", revision: 0 }),
      RefreshAppleContacts: () => Effect.succeed({ status: "off", revision: 0 }),
      AppleContactIdentifier: () => Effect.succeed(null),
      ContactGroups: ({ query, accountIds }) => m.contactGroups(query, accountIds),
      ContactPhoto: ({ accountId, address }) => m.contactPhoto(accountId, address),
      AttachmentCapabilities: () => Effect.succeed({ share: Boolean(options.native) }),
      UpdateState: () => Effect.succeed({ status: "disabled" }),
      ClipboardAttachments: () => Effect.succeed([]),
      SetNativeMenuState: () => Effect.void,
      SpellcheckLanguages: () => Effect.succeed({ languages: [], automatic: true }),
      SetPrefs: ({ patch }) => m.setPrefs(patch),
      SuggestContacts: ({ query, exclude, accountIds }) =>
        m.suggestContacts(query, { exclude, accountIds }),
      ContactAlternatives: ({ address }) => m.contactAlternatives(address),
      ImportCalendarAttachment: unsupported,
      InspectAttachment: unsupported,
      Unsubscribe: unsupported,
      OpenMailLink: unsupported,
      ComposeNew: () =>
        PubSub.publish(desktop, { _tag: "Command", command: "compose" }).pipe(Effect.asVoid),
      ComposeMessage: (input) =>
        PubSub.publish(desktop, { _tag: "ComposeMessage", ...input }).pipe(Effect.asVoid),
      ClaimInlineDraft: () => Effect.succeed(true),
      SetWindowSelection: () => Effect.void,
      CrashReportPending: () => Effect.succeed(false),
      SetActiveSpace: () => Effect.void,
      SetSendState: () => Effect.void,
      SetDesktopLabels: () => Effect.void,
      DesktopEvents: () =>
        Stream.fromPubSub(desktop).pipe(Stream.onStart(Deferred.succeed(desktopReady, undefined))),
    }),
  );
  const protocol = Layer.effect(
    RpcServer.Protocol,
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      return yield* RpcServer.Protocol.make(
        Effect.fnUntraced(function* (writeRequest) {
          const parser = serialization.makeUnsafe();
          const dispatch = yield* FiberSet.makeRuntime();
          bridge.send = (frame) => {
            // IO boundary, identical JSON frame encoding to the preload transport.
            const decoded = decodeRpcFrame(frame);
            if (!decoded) return;
            for (const message of decoded) if (message._tag === "Request") requests.push(message);
            // Electron IPC delivers on a later turn, including short-lived key clients.
            queueMicrotask(() =>
              dispatch(
                Effect.forEach(decoded, (message) => writeRequest(1, message), { discard: true }),
              ),
            );
          };
          return {
            disconnects: yield* Queue.make<number>(),
            send: (_id, response) =>
              Effect.sync(() => {
                const publicResponse = publicRpcResponse(response);
                responses.push(publicResponse);
                const frame = parser.encode(publicResponse);
                if (typeof frame === "string")
                  queueMicrotask(() => {
                    for (const listener of listeners) listener(frame);
                  });
              }),
            end: () => Effect.void,
            clientIds: Effect.succeed(new Set([1])),
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
  const rpcRuntime = ManagedRuntime.make(
    RpcServer.layer(MailRpcs).pipe(
      Layer.provide(handlers),
      Layer.provide(protocol),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  await rpcRuntime.runPromise(Effect.void);
  const registry = AtomRegistry.make();
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  render(
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(
        I18nProvider,
        { i18n },
        createElement(
          TipProvider,
          null,
          options.thread
            ? createElement(ThreadWindow, { id: `${account.id}/${options.thread}` })
            : createElement(App, { composeId }),
        ),
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
    async event(event: DesktopEvent) {
      await act(async () => {
        await Effect.runPromise(PubSub.publish(desktop, event));
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
      cleanup();
      registry.dispose();
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
