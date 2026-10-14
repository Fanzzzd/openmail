// @vitest-environment jsdom
import { act, createElement, useCallback, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Effect } from "effect";
import { Mailbox, type MobileDatabaseState } from "@openmail/core/portable";
import { afterEach, expect, it, vi } from "vitest";
import { MailboxProvider, useMailbox, useMailboxQuery } from "./mailbox";
import { useMessageInlineImages } from "./inline-images";

const translations = vi.hoisted(() => ({ i18n: { _: () => "Loading" } }));
vi.mock("@lingui/react", () => ({ useLingui: () => translations }));
vi.mock("react-native", () => ({
  ActivityIndicator: () => null,
  Text: "span",
  View: "div",
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("./platform", async () => {
  const { TestMailbox } = await import("@openmail/core/testing/node");
  return {
    mobileMailboxLayer: () =>
      TestMailbox({}, { backgroundFlush: false, imapIdle: false, localDraftQueue: true }),
  };
});
vi.mock("./platform/database-recovery", async () => {
  const { MobileDatabaseRecovery } = await import("@openmail/core/portable");
  const { Effect, Layer, ManagedRuntime } = await import("effect");
  const runtime = ManagedRuntime.make(
    Layer.succeed(MobileDatabaseRecovery, {
      inspect: () => Effect.succeed<MobileDatabaseState>({ kind: "healthy" }),
      open: () => Effect.die(new Error("unused")),
      rebuild: Effect.die(new Error("unused")),
      acknowledge: Effect.void,
    }),
  );
  return { databaseRecoveryRuntime: () => runtime };
});
afterEach(() => vi.unstubAllGlobals());
it("mailbox revision keeps the mounted reader and its resolved CID images while thread reload is pending", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const binding: { runtime: ReturnType<typeof useMailbox> | null } = { runtime: null };
  let release: (value: string) => void = () => {
    throw new Error("No pending query");
  };
  const load = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce("mail")
    .mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
  const fetch = vi.fn(async () => ({ photo: "data:image/png;base64,AQID" }));
  let mounts = 0;
  function Message({ id }: { id: string }) {
    useEffect(() => {
      mounts++;
    }, []);
    const images = useMessageInlineImages(id, '<img src="cid:photo">', true, fetch);
    return createElement("span", null, images.kind, images.value.photo);
  }
  function Reader() {
    const mailbox = useMailbox();
    useEffect(() => {
      binding.runtime = mailbox;
    }, [mailbox]);
    const query = useMailboxQuery(
      useCallback(() => load(), []),
      { keepPrevious: true },
    );
    return query.kind === "ready"
      ? createElement(Message, { id: query.value })
      : createElement("span", null, "loading-thread");
  }
  try {
    await act(async () => {
      root.render(createElement(MailboxProvider, null, createElement(Reader)));
    });
    await vi.waitFor(async () => {
      await act(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      expect(container.textContent).toBe("readydata:image/png;base64,AQID");
    });
    const mounted = container.querySelector("span");
    const instance = binding.runtime;
    if (!instance) throw new Error("No mailbox runtime");
    await act(async () => {
      await instance.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.app.setPrefs({ remoteImages: "always" })),
      );
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(container.querySelector("span")).toBe(mounted);
    expect(container.textContent).toBe("readydata:image/png;base64,AQID");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
    await act(async () => release("mail"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mounts).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
});
