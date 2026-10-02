import { act, createElement, type ReactNode } from "react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_PREFS, type Account } from "@openmail/core/schema";
import { afterAll, expect, it, vi } from "vitest";
import { emptyDraft } from "./draft";
import { testDom } from "./test-dom";

const calls = vi.hoisted(() => {
  vi.resetModules();
  return { sender: vi.fn() };
});
vi.mock("@effect/atom-react", () => ({
  useAtom: () => [AsyncResult.initial(), vi.fn()],
  useAtomSet: () => vi.fn(),
  useAtomValue: (atom: string) => AsyncResult.success(atom === "prefs" ? DEFAULT_PREFS : []),
}));
vi.mock("./state/queries", () => ({
  prefsAtom: "prefs",
  sendAsAtom: "aliases",
  templatesAtom: "templates",
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
    f: (call: (tag: string, payload: unknown) => Effect.Effect<null>) => Effect.Effect<unknown>,
  ) =>
    f((tag, payload) =>
      Effect.sync(() => {
        if (tag === "SuggestSender") calls.sender(payload);
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
vi.mock("./components/DraftOrganization", () => ({ DraftOrganization: () => null }));
vi.mock("./components/SystemSettings", () => ({ useShortcutText: () => () => "" }));
vi.mock("./components/ui/Select", () => ({ Select: () => null }));
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
    calls.sender.mockClear();
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
