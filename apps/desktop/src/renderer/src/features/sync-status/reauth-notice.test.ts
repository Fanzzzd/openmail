// @vitest-environment jsdom
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { KEYCHAIN_LOCKED_MESSAGE, type ReauthReason } from "@openmail/core/schema";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Account } from "../../../../shared/api";
import { setPlatform } from "../../lib/platform";
import { MailStatusNotice, ReauthNotice } from "./MailStatusNotice";

const account = (reauthReason?: ReauthReason): Account => ({
  id: "gmail:me@gmail.com",
  provider: "gmail",
  email: "me@gmail.com",
  createdAt: 0,
  lastSyncedAt: 0,
  lastSyncError: null,
  profileId: null,
  needsReauth: true,
  ...(reauthReason ? { reauthReason } : {}),
});

function render(node: ReturnType<typeof createElement>) {
  return renderElement(node).text;
}

function renderElement(node: ReturnType<typeof createElement>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  act(() => root.render(createElement(I18nProvider, { i18n }, node)));
  const text = element.textContent;
  const buttons = [...element.querySelectorAll("button")].map((button) => button.textContent);
  act(() => root.unmount());
  return { text, buttons };
}

it("in the web build, sends the person to the Mac instead of offering a sign-in it would refuse", () => {
  for (const provider of ["gmail", "imap"] as const) {
    const notice = createElement(ReauthNotice, {
      account: { ...account(), provider },
      onReauth: vi.fn(),
    });
    expect(renderElement(notice).buttons).toContain("Sign in again");
    setPlatform("web");
    try {
      const web = renderElement(notice);
      expect(web.buttons).toEqual([]);
      expect(web.text).toContain("Sign in again on your Mac");
    } finally {
      setPlatform("desktop");
    }
  }
});

it("each reauth reason has its own message, and none asks the person to publish an app", () => {
  const expected: [ReauthReason | undefined, string][] = [
    ["token_revoked", "me@gmail.com's sign-in was revoked or has expired."],
    [
      "testing_mode_expiry",
      "Google currently limits OpenMail's sign-in to 7 days. Sign in again to keep syncing me@gmail.com.",
    ],
    ["scope_missing", "me@gmail.com needs to grant mail permissions again."],
    ["client_mismatch", "The OAuth client that signed in me@gmail.com is no longer configured."],
    ["keychain_missing", "me@gmail.com's saved sign-in is missing from the keychain."],
    ["imap_auth_failed", "The mail server rejected the password for me@gmail.com."],
    [undefined, "me@gmail.com's sign-in has expired."],
  ];
  const seen = new Set<string>();
  for (const [reason, text] of expected) {
    const shown = render(
      createElement(ReauthNotice, { account: account(reason), onReauth: vi.fn() }),
    );
    expect(shown).toContain(text);
    expect(shown).toContain("Sign in again");
    // The built-in client's Testing status is OpenMail's to fix, not the person's.
    expect(shown).not.toMatch(/Publish|docs\//);
    seen.add(shown);
  }
  expect(seen.size).toBe(expected.length);
});

it("a locked keychain shows its own notice instead of a sign-in or a sync failure", () => {
  const ok = { ...account(), needsReauth: false };
  const shown = render(
    createElement(MailStatusNotice, {
      accounts: [ok],
      space: [ok],
      online: true,
      syncState: {
        running: false,
        lastFinishedAt: 1,
        errors: [`${ok.id}: ${KEYCHAIN_LOCKED_MESSAGE}`],
      },
      accountIssues: true,
      onReauth: vi.fn(),
      onFocusList: vi.fn(),
    }),
  );
  expect(shown).toContain("The keychain is locked. Unlock your computer and sync resumes");
  expect(shown).not.toContain("Sign in again");
  expect(shown).not.toContain("Could not sync");
});
