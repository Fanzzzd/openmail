// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Mailbox } from "@openmail/core/portable";
import { TestMailbox } from "@openmail/core/testing/node";
import { ManagedRuntime, Stream } from "effect";
import { composeMessage } from "./workflows";

const fixture = vi.hoisted(() => ({
  enabled: true,
  automatic: false,
  response: {
    kind: "ready",
    text: '<img src="https://private.test/image"> https://private.test/link',
  },
  run: vi.fn<(request: (mailbox: Mailbox["Service"]) => unknown) => void>(),
  cancel: vi.fn(),
}));
vi.mock("./ai-request", () => ({
  useAiRequest: () => ({
    enabled: fixture.enabled,
    account: { autoSummaries: fixture.automatic },
    response: fixture.response,
    run: fixture.run,
    cancel: fixture.cancel,
  }),
}));
vi.mock("@lingui/react", () => ({
  useLingui: () => ({ i18n: { _: (descriptor: { message: string }) => descriptor.message } }),
}));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", {}, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, children),
  TextInput: () => createElement("input"),
  Modal: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  ScrollView: ({ children }: { children: ReactNode }) => createElement("div", {}, children),
  StyleSheet: { create: (style: unknown) => style },
}));
import { ThreadAi, ComposeAi } from "./ai-controls";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
const root = createRoot(container);
const update = (action: () => void) =>
  act(async () => {
    action();
    await Promise.resolve();
  });
const button = (label: string) => {
  const found = Array.from(container.querySelectorAll("button")).find(
    (element) => element.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
};
afterEach(async () => {
  await update(() => root.render(null));
  fixture.enabled = true;
  fixture.automatic = false;
  vi.clearAllMocks();
});
it("AI output remains literal text and loading links or images requires no renderer", async () => {
  await update(() =>
    root.render(createElement(ThreadAi, { accountId: "account", messageId: "account/m" })),
  );
  expect(container.textContent).toContain(fixture.response.text);
  expect(container.querySelector("img, a, iframe, video")).toBe(null);
  expect(fixture.run).not.toHaveBeenCalled();
});
it("automatic summaries require both per-account consent and the automatic option", async () => {
  fixture.enabled = false;
  fixture.automatic = true;
  await update(() =>
    root.render(createElement(ThreadAi, { accountId: "account", messageId: "account/m" })),
  );
  expect(fixture.run).not.toHaveBeenCalled();
  fixture.enabled = true;
  fixture.automatic = false;
  await update(() =>
    root.render(createElement(ThreadAi, { accountId: "account", messageId: "account/m" })),
  );
  expect(fixture.run).not.toHaveBeenCalled();
  fixture.automatic = true;
  await update(() =>
    root.render(createElement(ThreadAi, { accountId: "account", messageId: "account/m" })),
  );
  expect(fixture.run).toHaveBeenCalledTimes(1);
  await update(() =>
    root.render(createElement(ThreadAi, { accountId: "account", messageId: "account/m" })),
  );
  expect(fixture.run).toHaveBeenCalledTimes(1);
});
it("compose help needs explicit acceptance and an edited draft invalidates the generated replacement", async () => {
  const accept = vi.fn();
  const message = { ...composeMessage("new"), text: "Original draft" };
  await update(() =>
    root.render(createElement(ComposeAi, { accountId: "account", message, accept })),
  );
  await update(() => button("Shorten").click());
  expect(accept).not.toHaveBeenCalled();
  expect(button("Apply draft change").disabled).toBe(false);
  await update(() => button("Apply draft change").click());
  expect(accept).toHaveBeenCalledWith(expect.objectContaining({ text: fixture.response.text }));
  accept.mockClear();
  await update(() =>
    root.render(
      createElement(ComposeAi, {
        accountId: "account",
        message: { ...message, text: "Edited after generation" },
        accept,
      }),
    ),
  );
  expect(button("Apply draft change").disabled).toBe(true);
  await update(() => button("Apply draft change").click());
  expect(accept).not.toHaveBeenCalled();
});

it("rewrites only the authored reply and preserves the signature, quote and untouched formatting", async () => {
  const accept = vi.fn();
  const message = {
    ...composeMessage("new"),
    mode: "reply" as const,
    text: "My reply\n\n-- \nMy signature\n\n> Original quote",
    html: "<strong>My reply</strong><br><br>-- <br><em>My signature</em><br><br>&gt; Original quote",
  };
  await update(() =>
    root.render(createElement(ComposeAi, { accountId: "account", message, accept })),
  );
  await update(() => button("Rewrite").click());
  expect(container.textContent).toContain("My reply");
  const runtime = ManagedRuntime.make(
    TestMailbox({}, { backgroundFlush: false, localDraftQueue: true }),
  );
  try {
    const mailbox = await runtime.runPromise(Mailbox);
    const generate = vi.spyOn(mailbox, "composeAi").mockReturnValue(Stream.empty);
    const request = fixture.run.mock.calls[0]?.[0];
    if (!request) throw new Error("Missing AI request");
    request(mailbox);
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ text: "My reply" }));
  } finally {
    await runtime.dispose();
  }
  await update(() => button("Apply draft change").click());
  expect(accept.mock.calls[0]?.[0]).toMatchObject({
    text: `${fixture.response.text}\n\n-- \nMy signature\n\n> Original quote`,
  });
});
