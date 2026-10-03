// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { FailedOpNoticeContent } from "./components/FailedOpNotice";

it("keeps failed changes visible until acknowledged and exposes provider and delivery details", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const dismiss = vi.fn();
  const resend = vi.fn();
  const failures = [
    {
      id: 24,
      accountId: "account",
      providerId: "queued",
      at: 1000,
      kind: "send",
      subject: "Queued draft",
      sender: null,
      reason: "Send window expired",
    },
    {
      id: 21,
      accountId: "account",
      providerId: "uid:2",
      at: 1000,
      kind: "archive",
      subject: "Planning review",
      sender: "Alice <alice@example.test>",
      reason: "Access denied",
    },
    {
      id: 22,
      accountId: "account",
      providerId: "draft",
      at: 1000,
      kind: "sendPartial",
      subject: "Team update",
      sender: "me@example.test",
      reason: "Rejected: bad@example.test",
    },
    {
      id: 23,
      accountId: "account",
      providerId: "draft2",
      at: 1000,
      kind: "sentCopyMissing",
      subject: null,
      sender: null,
      reason: "APPEND failed",
    },
  ];
  const render = (entries: typeof failures) =>
    root.render(
      createElement(
        I18nProvider,
        { i18n },
        createElement(FailedOpNoticeContent, {
          failures: entries,
          accountName: () => "me@example.test",
          dismiss,
          resend,
        }),
      ),
    );
  try {
    await act(async () => render(failures));
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(
      "2 changes could not be saved1 message had rejected recipients1 sent message is missing from Sent",
    );
    const details = element.querySelector("button");
    if (!details) throw new Error("Missing details action");
    await act(async () => details.click());
    expect(element.textContent).toContain("Access denied");
    expect(element.textContent).toContain("Archive");
    expect([...element.querySelectorAll("p")].some((entry) => entry.textContent === "Send")).toBe(
      true,
    );
    expect(element.textContent).toContain("Planning review");
    expect(element.textContent).toContain("Alice <alice@example.test>");
    expect(element.textContent).toContain("me@example.test");
    expect(element.textContent).toContain("Some recipients did not receive this message.");
    expect(element.textContent).toContain("Partial delivery");
    expect(element.textContent).toContain("Save sent copy");
    expect(element.textContent).toContain("bad@example.test");
    expect(element.textContent).toContain("Your draft was kept. Check Sent before sending again.");
    expect(element.textContent).toContain(
      "The message was sent, but its copy is missing from Sent.",
    );
    const resendButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Resend to rejected recipients",
    );
    expect(
      [...element.querySelectorAll("button")].filter(
        (button) => button.textContent === "Resend to rejected recipients",
      ),
    ).toHaveLength(1);
    if (!resendButton) throw new Error("Missing rejected-recipient resend action");
    await act(async () => resendButton.click());
    expect(resend).toHaveBeenCalledWith(22);
    expect(dismiss).not.toHaveBeenCalled();
    const dismissButton = [...element.querySelectorAll("button")].find(
      (button) => button.textContent === "Dismiss",
    );
    if (!dismissButton) throw new Error("Missing dismiss action");
    await act(async () => dismissButton.click());
    expect(dismiss).toHaveBeenCalledWith([24, 21, 22, 23]);
    expect(element.textContent).toContain("2 changes could not be saved");
    await act(async () => render([]));
    expect(element.textContent).toBe("");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
