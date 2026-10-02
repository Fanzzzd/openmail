import { act, createElement, type ReactNode } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS, type Account, type SendAs, type Message } from "@openmail/core/schema";
import { afterAll, expect, it, vi } from "vitest";
import { emptyDraft, draftFor } from "./draft";
import { testDom } from "./test-dom";

const calls = vi.hoisted(() => {
  vi.resetModules();
  return {
    sender: vi.fn<(payload: unknown) => { accountId: string; address: string } | null>(),
    recovery: vi.fn(),
    aliases: new Array<SendAs>(),
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtom: () => [AsyncResult.initial(), vi.fn()],
  useAtomSet: () => vi.fn(),
  useAtomValue: (atom: string) =>
    atom === "status"
      ? AsyncResult.initial()
      : AsyncResult.success(
          atom === "prefs" ? DEFAULT_PREFS : atom === "aliases" ? calls.aliases : [],
        ),
}));
vi.mock("./state/queries", () => ({
  prefsAtom: "prefs",
  sendAsAtom: "aliases",
  templatesAtom: "templates",
  signaturesAtom: "signatures",
  namedSignaturesAtom: "namedSignatures",
  draftStatusAtom: () => "status",
  threadAtom: () => "thread",
}));
vi.mock("./state/mutations", () => ({
  saveDraftAtom: () => "save",
  saveTemplateAtom: "template",
  setPrefsAtom: "setPrefs",
}));
vi.mock("./state/mail", () => ({
  useRunMail: () => Effect.runSync,
  withMail: (
    f: (
      call: (
        tag: string,
        payload: unknown,
      ) => Effect.Effect<{ accountId: string; address: string } | null>,
    ) => Effect.Effect<unknown>,
  ) =>
    f((tag, payload) =>
      Effect.sync(() => {
        if (tag === "SuggestSender") return calls.sender(payload) ?? null;
        if (tag === "RecoverDraft") calls.recovery(payload);
        return null;
      }),
    ),
  openDraft: () => Effect.succeed(null),
}));
vi.mock("@base-ui/react/dialog", () => ({
  Dialog: {
    Root: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Portal: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Backdrop: () => null,
    Popup: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    Title: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  },
}));
vi.mock("./components/RecipientField", () => ({ RecipientField: () => null }));
vi.mock("./components/ComposeEditor", () => ({ ComposeEditor: () => null }));
vi.mock("./components/ComposerAi", () => ({ ComposerAi: () => null }));
vi.mock("./components/DraftOrganization", () => ({ DraftOrganization: () => null }));
vi.mock("./components/SystemSettings", () => ({ useShortcutText: () => () => "" }));
vi.mock("./components/ui/Select", () => ({
  Select: (props: { value: string; "aria-label": string }) =>
    createElement("output", { "aria-label": props["aria-label"] }, props.value),
}));
vi.mock("./components/ui/Tip", () => ({
  Tip: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./components/ui/Dialog", () => ({
  Alert: () => null,
  AlertCancel: () => null,
  alertButton: "",
  alertPrimary: "",
  alertDanger: "",
}));
vi.mock("./components/ui/Picker", () => ({
  PickerPopover: () => null,
  pickerFooter: "",
  pickerInput: "",
  pickerItem: "",
  pickerList: "",
}));
import { Composer } from "./components/Composer";

afterAll(() => {
  for (const name of [
    "@effect/atom-react",
    "./state/queries",
    "./state/mutations",
    "./state/mail",
    "@base-ui/react/dialog",
    "./components/RecipientField",
    "./components/ComposeEditor",
    "./components/ComposerAi",
    "./components/DraftOrganization",
    "./components/SystemSettings",
    "./components/ui/Select",
    "./components/ui/Tip",
    "./components/ui/Dialog",
    "./components/ui/Picker",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});
const account: Account = {
  id: "gmail:me@example.com",
  email: "me@example.com",
  provider: "gmail",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
for (const synced of [true, false, undefined]) {
  it(`From suggestions ${synced === undefined ? "run for a fresh compose" : "leave reopened manually chosen From alone"} (${String(synced)})`, async () => {
    vi.useFakeTimers();
    calls.sender.mockReset();
    calls.aliases = [];
    const dom = testDom();
    try {
      const draft = {
        ...emptyDraft(account.id),
        to: "alice@example.com",
        from: { name: "Manual", address: account.email },
        synced,
      };
      dom.render(
        createElement(
          I18nProvider,
          { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
          createElement(Composer, {
            draft,
            accounts: [account],
            signatureFor: () => "",
            onClose: vi.fn(),
            onDiscard: vi.fn(),
            onSend: vi.fn(),
          }),
        ),
      );
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(calls.sender).toHaveBeenCalledTimes(synced === undefined ? 1 : 0);
    } finally {
      dom.dispose();
      vi.useRealTimers();
    }
  });
}

const alias: SendAs = {
  accountId: account.id,
  address: "alias@example.com",
  name: "Alias",
  isDefault: false,
  signature: "",
};
const original: Message = {
  id: "one",
  accountId: account.id,
  threadId: "one",
  from: { name: "Alice", address: "alice@example.com" },
  to: [{ name: "", address: alias.address }],
  cc: [],
  subject: "Hello",
  snippet: "",
  bodyText: "Hello",
  bodyHtml: "",
  date: 1,
  labels: ["INBOX"],
  attachments: [],
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
};
for (const preference of ["received", "default"] as const) {
  it(`Reply From ${preference} wins over best-From suggestions`, async () => {
    vi.useFakeTimers();
    calls.sender.mockReset();
    calls.sender.mockReturnValue({ accountId: account.id, address: "other@example.com" });
    calls.aliases = [alias];
    const dom = testDom();
    try {
      const draft = draftFor("reply", original, account, false, [alias], undefined, {
        preference,
        aliases: [alias],
      });
      dom.render(
        createElement(
          I18nProvider,
          { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
          createElement(Composer, {
            draft,
            accounts: [account],
            signatureFor: () => "",
            onClose: vi.fn(),
            onDiscard: vi.fn(),
            onSend: vi.fn(),
          }),
        ),
      );
      await act(() => vi.advanceTimersByTimeAsync(350));
      expect(calls.sender).not.toHaveBeenCalled();
      expect(dom.element.querySelector('[aria-label="From"]')?.textContent).toBe(
        `${account.id}/${preference === "received" ? alias.address : account.email}`,
      );
    } finally {
      dom.dispose();
      vi.useRealTimers();
    }
  });
}
it("best-From still changes the verified sender for new mail", async () => {
  vi.useFakeTimers();
  calls.sender.mockReset();
  calls.sender.mockReturnValue({ accountId: account.id, address: alias.address });
  calls.aliases = [alias];
  const dom = testDom();
  try {
    const draft = { ...emptyDraft(account.id), to: "alice@example.com" };
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(Composer, {
          draft,
          accounts: [account],
          signatureFor: () => "",
          onClose: vi.fn(),
          onDiscard: vi.fn(),
          onSend: vi.fn(),
        }),
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(350));
    expect(dom.element.querySelector('[aria-label="From"]')?.textContent).toBe(
      `${account.id}/${alias.address}`,
    );
  } finally {
    dom.dispose();
    vi.useRealTimers();
  }
});
it("Retry sends current edits in one recovery request without first switching to local-only", () => {
  calls.recovery.mockClear();
  calls.aliases = [];
  const dom = testDom();
  try {
    const draft = {
      ...emptyDraft(account.id),
      to: "alice@example.com",
      syncError: "Raw provider details",
      syncRetrying: false,
      subject: "Current edits",
    };
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(Composer, {
          draft,
          accounts: [account],
          signatureFor: () => "",
          onClose: vi.fn(),
          onDiscard: vi.fn(),
          onSend: vi.fn(),
        }),
      ),
    );
    const retry = [...dom.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    act(() => retry?.click());
    expect(calls.recovery).toHaveBeenCalledTimes(1);
    expect(calls.recovery).toHaveBeenCalledWith(
      expect.objectContaining({
        id: draft.id,
        action: "retry",
        draft: expect.objectContaining({
          id: draft.id,
          message: expect.objectContaining({ subject: "Current edits" }),
        }),
      }),
    );
    expect(dom.element.textContent).not.toContain("Raw provider details");
  } finally {
    dom.dispose();
  }
});
