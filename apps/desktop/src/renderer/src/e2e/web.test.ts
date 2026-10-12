import { RegistryContext } from "@effect/atom-react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Mailbox } from "@openmail/core/portable";
import { fakeServer, TemporaryTestMailbox } from "@openmail/core/testing/node";
import { cleanup, render, screen } from "@testing-library/react/pure";
import { createMemoryHistory } from "@tanstack/react-router";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { AtomRegistry } from "effect/reactivity";
import { createElement } from "react";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { createConnectionHub, remoteRpcServer } from "../../../main/remote/remote-rpc-server";
import { DEFAULT_VIEW, mailHref } from "../../../shared/routes";
import { setPlatform } from "../lib/platform";
import { AppRouterProvider } from "../routes/provider";
import { createAppRouter, historyFor, initialLocation } from "../routes/router";
import { historyAtom, locationAtom } from "../state/location";
import { setRpcBridge } from "../state/rpc-bridge";
import { webSocketBridge, type WebConnection } from "../state/web-socket-bridge";
import { TipProvider } from "../ui/Tip";
import { eventually, incoming } from "./harness";

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  setPlatform("desktop");
});

it("the web build renders the inbox over a WebSocket and calls only remote RPCs", async () => {
  const server = fakeServer("me@gmail.com", [
    incoming("one", { subject: "Quarterly report" }),
    incoming("two", { subject: "Lunch on Friday" }),
  ]);
  const mailboxRuntime = ManagedRuntime.make(TemporaryTestMailbox({ gmail: server }));
  const m = await mailboxRuntime.runPromise(Mailbox);
  await mailboxRuntime.runPromise(m.connect({ provider: "gmail" }));
  await mailboxRuntime.runPromise(
    m.setPrefs({ language: "en", defaultProfilesPrompted: true, remoteImages: "ask" }),
  );
  await mailboxRuntime.runPromise(m.sync());

  // The fake server side: the real remote RPC group and handlers on a WebSocket.
  const hub = createConnectionHub();
  const denied: string[] = [];
  const tags: string[] = [];
  const rpc = Effect.runFork(
    Layer.launch(remoteRpcServer(hub, (tag) => denied.push(tag))).pipe(
      Effect.provideService(Mailbox, m),
    ),
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
  for (let i = 0; i < 200 && !hub.listening; i++)
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const states: WebConnection[] = [];
  setPlatform("web");
  // jsdom's events and Node's WebSocket don't mix; the ws client speaks the same API.
  setRpcBridge(
    webSocketBridge(
      `ws://127.0.0.1:${port}/rpc`,
      (state) => states.push(state),
      (url) => new NodeWebSocket(url),
    ),
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
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
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
    expect(screen.getAllByText("Lunch on Friday").length).toBeGreaterThan(0);
  });
  expect(states).toContain("open");
  expect(tags).toContain("Threads");
  // Startup in the browser never reaches for a Mac-only RPC.
  expect(denied).toEqual([]);
  // Signing in to a new account belongs to the Mac.
  expect(screen.queryByRole("button", { name: "Add email account" })).toBeNull();
});
