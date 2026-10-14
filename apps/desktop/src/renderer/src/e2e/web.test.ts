import { RegistryContext } from "@effect/atom-react";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Mailbox } from "@openmail/core/portable";
import { fakeServer, TemporaryTestMailbox } from "@openmail/core/testing/node";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure";
import { createMemoryHistory } from "@tanstack/react-router";
import { Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect";
import { RpcClient, type RpcClientError } from "effect/rpc";
import { AtomRegistry } from "effect/reactivity";
import { createElement } from "react";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { createConnectionHub, remoteRpcServer } from "../../../main/remote/remote-rpc-server";
import { DEFAULT_VIEW, mailHref } from "../../../shared/routes";
import { setPlatform } from "../lib/platform";
import { AppRouterProvider } from "../routes/provider";
import { createAppRouter, historyFor, initialLocation } from "../routes/router";
import { historyAtom, locationAtom } from "../state/location";
import { MailRpcs } from "../../../shared/rpc";
import { ElectronProtocol } from "../state/rpc";
import { setRpcBridge } from "../state/rpc-bridge";
import { webSocketBridge, type WebConnection } from "../state/web-socket-bridge";
import { TipProvider } from "../ui/Tip";
import { eventually, incoming } from "./harness";
import { scaledMs } from "../../../../../../packages/core/test-support/test-time.js";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  setPlatform("desktop");
});

/**
 * The web build against the Mac's real remote RPC server and fake mail. The
 * server records each denied call and each failed one.
 */
async function openWebApp(mailbox: (m: Mailbox["Service"]) => Mailbox["Service"] = (m) => m) {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const server = fakeServer("me@gmail.com", [
    incoming("one", { subject: "Quarterly report" }),
    incoming("two", { subject: "Lunch on Friday" }),
  ]);
  const mailboxRuntime = ManagedRuntime.make(TemporaryTestMailbox({ gmail: server }));
  const m = await mailboxRuntime.runPromise(Mailbox);
  await mailboxRuntime.runPromise(m.accounts.connect({ provider: "gmail" }));
  await mailboxRuntime.runPromise(
    m.app.setPrefs({ language: "en", defaultProfilesPrompted: true, remoteImages: "ask" }),
  );
  await mailboxRuntime.runPromise(m.sync.sync());

  // The fake server side: the real remote RPC group and handlers on a WebSocket.
  const hub = createConnectionHub();
  const denied: string[] = [];
  const failures: string[] = [];
  const tags: string[] = [];
  const rpc = Effect.runFork(
    Layer.launch(
      remoteRpcServer(hub, {
        denied: (tag) => denied.push(tag),
        failure: (failure) => failures.push(failure.rpc),
      }),
    ).pipe(Effect.provideService(Mailbox, mailbox(m))),
  );
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    wss.once("listening", resolve);
  });
  wss.on("connection", (socket) => {
    const handlers = hub.onConnection({
      send: (frame) => socket.send(frame),
      close: (code, reason) => socket.close(code, reason),
    });
    socket.on("message", (data: Buffer) => {
      const frame = data.toString("utf8");
      // IO boundary: one encoded request frame.
      const parsed = JSON.parse(frame) as { _tag?: string; tag?: string };
      if (parsed._tag === "Request" && parsed.tag) tags.push(parsed.tag);
      handlers.message(frame);
    });
    socket.once("close", () => handlers.closed());
  });
  await vi.waitFor(() => expect(hub.listening).toBe(true), {
    timeout: scaledMs(2_000),
    interval: 10,
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const states: WebConnection[] = [];
  setPlatform("web");
  // jsdom's events and Node's WebSocket don't mix; the ws client speaks the same API.
  setRpcBridge(
    webSocketBridge(`ws://127.0.0.1:${port}/rpc`, (state) => states.push(state), {
      create: (url) => {
        const socket = new NodeWebSocket(url);
        // A browser reports a refused socket as a close only; ws also emits an error.
        socket.on("error", () => null);
        return socket;
      },
      // The server stops when the test ends; no reconnect while the file is still running.
      delays: [60_000],
    }),
  );

  const registry = AtomRegistry.make();
  const router = createAppRouter(createMemoryHistory({ initialEntries: [mailHref(DEFAULT_VIEW)] }));
  await router.load();
  registry.set(locationAtom, initialLocation(router));
  registry.set(historyAtom, historyFor(router));
  render(
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(
        I18nProvider,
        // The global instance, as in the app: core macros such as plural() read it.
        { i18n },
        createElement(TipProvider, null, createElement(AppRouterProvider, { router })),
      ),
    ),
  );
  dispose = async () => {
    cleanup();
    registry.dispose();
    await Effect.runPromise(Fiber.interrupt(rpc));
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
    await mailboxRuntime.dispose();
  };

  await eventually(() => {
    expect(screen.getAllByText("Quarterly report").length).toBeGreaterThan(0);
  });
  return {
    denied,
    failures,
    tags,
    states,
    server,
    sync: () => mailboxRuntime.runPromise(m.sync.sync()),
  };
}

it("the web build renders the inbox over a WebSocket and calls only remote RPCs", async () => {
  const { denied, tags, states } = await openWebApp();
  await eventually(() => {
    expect(screen.getAllByText("Lunch on Friday").length).toBeGreaterThan(0);
  });
  expect(states).toContain("open");
  expect(tags).toContain("Threads");
  // Startup in the browser never reaches for a Mac-only RPC.
  expect(denied).toEqual([]);
  // Signing in to a new account belongs to the Mac.
  expect(screen.queryByRole("button", { name: "Add email account" })).toBeNull();
});

const dialogs = () => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];

/**
 * Lets the click's RPCs reach the server and their replies render. A real
 * 30 ms window on purpose: this is a sweep for calls that should not happen,
 * and a click that makes no call has no event to wait for.
 */
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
  });

// Clicks every control in every tab: slower than the 10 s default under load.
it(
  "no web settings control calls an RPC or sets a preference the Mac refuses",
  { timeout: 60_000 },
  async () => {
    const { denied, failures } = await openWebApp();
    // Settings is a lazy chunk; load it before the click so the dialog opens at once.
    await import("../features/settings/Settings");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const tabs = (await screen.findAllByRole("tab")).map((tab) => tab.textContent);
    expect(tabs.length).toBeGreaterThan(5);
    for (const name of tabs) {
      fireEvent.click(screen.getByRole("tab", { name }));
      await settle();
      // Every switch, checkbox, option and button the tab shows, once each.
      const panel = screen.getByRole("tabpanel");
      const controls = ["button", "switch", "checkbox", "radio"].flatMap((role) =>
        within(panel).queryAllByRole(role),
      );
      for (const control of controls) {
        if (!control.isConnected || control.matches(":disabled, [aria-disabled=true]")) continue;
        const before = dialogs().length;
        fireEvent.click(control);
        await settle();
        // A control that opens a dialog (a new folder, a filter): close it again.
        for (const opened of dialogs().slice(before).toReversed()) {
          fireEvent.keyDown(opened, { key: "Escape" });
          await settle();
        }
      }
    }
    await settle();
    expect(denied).toEqual([]);
    expect(failures).toEqual([]);
  },
);

it("a remote handler that dies or is interrupted fails only its own call; live updates keep arriving", async () => {
  const web = await openWebApp((m) => ({
    ...m,
    proposals: { ...m.proposals, audit: () => Effect.die(new Error("handler bug")) },
    organize: { ...m.organize, undoHistory: Effect.interrupt },
  }));
  const call = <A, E>(
    f: (
      client: RpcClient.FromGroup<typeof MailRpcs, RpcClientError.RpcClientError>,
    ) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromiseExit(
      RpcClient.make(MailRpcs).pipe(
        Effect.flatMap(f),
        Effect.provide(ElectronProtocol),
        Effect.scoped,
      ),
    );
  const died = await call((client) => client.Audit({ limit: 1 }));
  expect(Exit.isFailure(died)).toBe(true);
  expect(JSON.stringify(died)).not.toContain("handler bug");
  expect(Exit.isFailure(await call((client) => client.UndoHistory()))).toBe(true);
  expect(Exit.isSuccess(await call((client) => client.Accounts()))).toBe(true);

  // A sync the Mac runs on its own reaches the page only through Events.
  web.server.messages.set("arrival", incoming("arrival", { subject: "Arrived later" }));
  await web.sync();
  await eventually(() => {
    expect(screen.getAllByText("Arrived later").length).toBeGreaterThan(0);
  });
  // The socket stayed up, and the Mac's log names the call that died.
  expect(web.states).not.toContain("lost");
  expect(web.failures).toContain("Audit");
});
