// @vitest-environment jsdom
import { i18n, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  KEYCHAIN_LOCKED_MESSAGE,
  type ReauthReason,
  SYNC_FAILURE_TEXT,
} from "@openmail/core/schema";
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
      "Google ended OpenMail's sign-in after 7 days. Sign in again to keep syncing me@gmail.com.",
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
    // Google's limits on the built-in client are OpenMail's to fix, not the person's.
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
  expect(shown).not.toContain("Couldn't sync");
});

it("the line names the provider and what happened; the full address is in the tooltip and the reason", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const long: Account = { ...account(), email: "a.very.long.address.for.work@gmail.com" };
  const cases: [Account, string][] = [
    [long, "Gmail sign-in expired"],
    [{ ...long, reauthReason: "testing_mode_expiry" }, "Gmail sign-in expired"],
    [{ ...long, reauthReason: "scope_missing" }, "Gmail needs permission again"],
    [
      { ...long, provider: "outlook", email: "me@outlook.com", reauthReason: "token_revoked" },
      "Outlook sign-in expired",
    ],
    [
      {
        ...long,
        provider: "imap",
        email: "me@icloud.com",
        imap: {
          preset: "icloud",
          username: "me@icloud.com",
          imapHost: "imap.mail.me.com",
          imapPort: 993,
          smtpHost: "smtp.mail.me.com",
          smtpPort: 587,
          smtpSecure: false,
        },
        reauthReason: "imap_auth_failed",
      },
      "iCloud password rejected",
    ],
    [
      { ...long, provider: "imap", email: "me@example.org", reauthReason: "imap_auth_failed" },
      "example.org password rejected",
    ],
  ];
  for (const [subject, headline] of cases) {
    const element = document.createElement("div");
    const root = createRoot(element);
    const i18n = setupI18n({ locale: "en", messages: { en: {} } });
    act(() =>
      root.render(
        createElement(
          I18nProvider,
          { i18n },
          createElement(ReauthNotice, { account: subject, onReauth: vi.fn() }),
        ),
      ),
    );
    const line = element.querySelector(".font-medium");
    expect(line?.textContent).toBe(headline);
    expect(line?.getAttribute("aria-hidden")).toBeNull();
    const notice = element.querySelector("[title]");
    expect(notice?.getAttribute("title")).toContain(subject.email);
    // The screen reader text after the line carries the full address.
    expect(element.querySelector(".sr-only")?.textContent).toContain(subject.email);
    act(() => root.unmount());
  }
});

it("a sync failure's tooltip shows fixed text, never the stored provider response", () => {
  const ok = { ...account(), needsReauth: false };
  const raw = `Gmail API 403: ${JSON.stringify({ error: { code: 403, message: "Quota exceeded" } })}`;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  const root = createRoot(element);
  const i18n = setupI18n({ locale: "en", messages: { en: {} } });
  const notice = (errors: string[]) =>
    createElement(
      I18nProvider,
      { i18n },
      createElement(MailStatusNotice, {
        accounts: [ok],
        space: [ok],
        online: true,
        syncState: { running: false, lastFinishedAt: 1, errors },
        accountIssues: true,
        onReauth: vi.fn(),
        onFocusList: vi.fn(),
      }),
    );
  act(() => root.render(notice([`${ok.id}: ${raw}`, `${ok.id}: ${SYNC_FAILURE_TEXT.quota}`])));
  const titles = [...element.querySelectorAll("[title]")].map((node) => node.getAttribute("title"));
  act(() => root.unmount());
  expect(titles.join("\n")).not.toContain("Quota exceeded");
  expect(titles.join("\n")).not.toContain(ok.id);
  // The account goes by its name, with each distinct reason once.
  expect(titles).toContain(
    `${ok.email}: Sync couldn't finish. It will retry automatically. The mail provider is limiting requests. Sync will try again later.`,
  );
});

it("two accounts with problems fold into one line under the same name as the sidebar's", () => {
  // The folded line's plural reads the global catalog, as in the app.
  i18n.loadAndActivate({ locale: "en", messages: {} });
  const first = account();
  const second = { ...account(), id: "gmail:you@gmail.com", email: "you@gmail.com" };
  const shown = render(
    createElement(MailStatusNotice, {
      accounts: [first, second],
      space: [first, second],
      online: true,
      syncState: { running: false, lastFinishedAt: 1, errors: [] },
      accountIssues: true,
      onReauth: vi.fn(),
      onFocusList: vi.fn(),
    }),
  );
  expect(shown).toContain("Sync failed for 2 accounts");
  expect(shown).not.toContain("need attention");
});
