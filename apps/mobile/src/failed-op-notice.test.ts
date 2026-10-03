// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FailedOpNotice } from "./failed-op-notice";

const mailbox = vi.hoisted(() => ({
  query: {
    kind: "ready",
    value: {
      failures: [
        {
          id: 5,
          accountId: "account",
          providerId: "queued",
          at: 1000,
          kind: "send",
          subject: "Queued draft",
          sender: null,
          reason: "Send window expired",
        },
        {
          id: 3,
          accountId: "account",
          providerId: "draft",
          at: 1000,
          kind: "sendPartial",
          subject: "Team update",
          sender: "me@example.test",
          reason: "Rejected: bad@example.test",
        },
        {
          id: 4,
          accountId: "account",
          providerId: "draft2",
          at: 1000,
          kind: "sentCopyMissing",
          subject: "Status",
          sender: null,
          reason: "APPEND failed",
        },
      ],
      accounts: [{ id: "account", email: "me@example.test" }],
    },
  },
  runPromise: vi.fn(async () => ({
    id: "rejected-only-new-draft",
    accountId: "account",
    message: {
      subject: "Team update",
      text: "Body",
      to: [{ name: "", address: "bad@example.test" }],
      cc: [],
      bcc: [],
    },
  })),
  push: vi.fn(),
}));
vi.mock("expo-router", () => ({ router: { push: mailbox.push } }));
vi.mock("./mailbox", () => ({ useMailbox: () => mailbox, useMailboxQuery: () => mailbox.query }));
vi.mock("react-native", () => ({
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
}));
vi.mock("./controls", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement("button", { onClick: onPress }, label),
  Sheet: ({ children }: { children: ReactNode }) => createElement("section", null, children),
}));

it("shows persistent mobile failure and delivery warnings with address details and dismiss action", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  try {
    await act(async () =>
      root.render(createElement(I18nProvider, { i18n }, createElement(FailedOpNotice))),
    );
    expect(element.textContent).toContain("1 message had rejected recipients");
    expect(element.textContent).toContain("1 sent message is missing from Sent");
    expect(element.textContent).not.toContain("changes could not be saved");
    const details = element.querySelector("button");
    if (!details) throw new Error("Missing details action");
    await act(async () => details.click());
    expect(element.textContent).toContain("me@example.test");
    expect(element.textContent).toContain("Team update");
    expect(element.textContent).toContain("Status");
    expect(element.textContent).toContain("Some recipients did not receive this message.");
    expect(element.textContent).toContain("Partial delivery");
    expect(element.textContent).toContain("Save sent copy");
    expect(
      [...element.querySelectorAll("span")].some((entry) => entry.textContent === "Send"),
    ).toBe(true);
    expect(element.textContent).toContain("bad@example.test");
    expect(element.textContent).toContain("Your draft was kept. Check Sent before sending again.");
    expect(element.textContent).toContain(
      "The message was sent, but its copy is missing from Sent.",
    );
    const resend = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Resend to rejected recipients",
    );
    expect(
      [...element.querySelectorAll("button")].filter(
        (button) => button.textContent === "Resend to rejected recipients",
      ),
    ).toHaveLength(1);
    if (!resend) throw new Error("Missing rejected-recipient resend action");
    await act(async () => resend.click());
    expect(mailbox.push).toHaveBeenCalledWith({
      pathname: "/compose",
      params: { draftId: "rejected-only-new-draft", accountId: "account" },
    });
    expect(element.textContent).toContain("1 message had rejected recipients");
    const dismiss = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    );
    if (!dismiss) throw new Error("Missing dismiss action");
    await act(async () => dismiss.click());
    expect(mailbox.runPromise).toHaveBeenCalledTimes(2);
    mailbox.runPromise.mockRejectedValueOnce(new Error("Database unavailable"));
    await act(async () => dismiss.click());
    expect(element.textContent).toContain("Could not dismiss this notice. Try again.");
    expect(element.textContent).toContain("1 message had rejected recipients");
    expect(element.textContent).toContain("1 sent message is missing from Sent");
    expect(element.textContent).not.toContain("changes could not be saved");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
