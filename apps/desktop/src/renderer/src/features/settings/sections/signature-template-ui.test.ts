import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { afterAll, expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import {
  type Template,
  type NamedSignature,
  type ComposeBody,
  DEFAULT_PREFS,
} from "@openmail/core/schema";
import { testDom } from "../../../test-support/test-dom";

const calls = vi.hoisted(() => {
  vi.resetModules();
  return {
    saveTemplate: vi.fn(),
    saveSignature: vi.fn(),
    setDefault: vi.fn(),
    setPrefs: vi.fn(),
    signatureOrder: new Array<string>(),
    removeTemplate: vi.fn(),
    removeSignature: vi.fn(),
    templates: new Array<Template>(),
    signatures: new Array<NamedSignature>(),
  };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (tag: string) =>
    AsyncResult.success(
      tag === "prefs"
        ? { ...DEFAULT_PREFS, signatureOrder: calls.signatureOrder }
        : tag === "templates"
          ? calls.templates
          : tag === "signatures"
            ? calls.signatures
            : [],
    ),
  useAtom: (tag: string) => [
    AsyncResult.initial(),
    tag === "saveTemplate" ? calls.saveTemplate : calls.saveSignature,
  ],
  useAtomSet: (tag: string) =>
    tag === "setPrefs"
      ? calls.setPrefs
      : tag === "setDefault"
        ? calls.setDefault
        : tag === "removeTemplate"
          ? calls.removeTemplate
          : calls.removeSignature,
}));
vi.mock("../../../state/queries", () => ({
  templatesAtom: "templates",
  namedSignaturesAtom: "signatures",
  signatureDefaultsAtom: "defaults",
  sendAsAtom: "aliases",
  prefsAtom: "prefs",
}));
vi.mock("../../../state/mutations", () => ({
  setPrefsAtom: "setPrefs",
  saveTemplateAtom: "saveTemplate",
  saveNamedSignatureAtom: "saveSignature",
  setSignatureDefaultAtom: "setDefault",
  deleteTemplateAtom: "removeTemplate",
  deleteNamedSignatureAtom: "removeSignature",
}));
vi.mock("../../../ui/Checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  }) =>
    createElement("input", {
      type: "checkbox",
      checked,
      onChange: (event) => onCheckedChange(event.currentTarget.checked),
    }),
}));
vi.mock("../../../ui/Select", () => ({
  Select: ({
    options,
    onValueChange,
    "aria-label": label,
  }: {
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
    "aria-label": string;
  }) =>
    createElement(
      "div",
      { "aria-label": label },
      options.map((option) =>
        createElement(
          "button",
          { type: "button", key: option.value, onClick: () => onValueChange(option.value) },
          option.label,
        ),
      ),
    ),
}));
// Keep the real form and sanitizer; isolate the rich editing widget from layout APIs.
vi.mock("../../compose/components/ComposeEditor", () => ({
  ComposeEditor: ({ body }: { body: ComposeBody }) =>
    createElement(
      "output",
      { "aria-label": "Signature body" },
      body.kind === "rich" ? body.html : body.text,
    ),
}));
import { TemplateSettings } from "./TemplateSettings";
import { DraftSyncRecovery } from "../../compose/components/DraftSyncRecovery";
import { SignatureSettings } from "./SignatureSettings";

function render(node: ReactNode) {
  const dom = testDom();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 0),
  );
  dom.render(
    createElement(I18nProvider, { i18n: setupI18n({ locale: "en", messages: {} }) }, node),
  );
  return dom;
}
function button(dom: ReturnType<typeof testDom>, text: string, scope: ParentNode = dom.element) {
  const found = [...scope.querySelectorAll("button")].find(
    (element) => element.textContent === text,
  );
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
const template: Template = {
  id: "template:1",
  name: "Greeting",
  subject: "Hello",
  to: [{ name: "John", address: "john@example.com" }],
  cc: [{ name: "", address: "cc@example.com" }],
  bcc: [{ name: "", address: "bcc@example.com" }],
  body: "Thanks",
  updatedAt: 0,
};

it("Settings edits every template field, inserts a predefined variable and saves the same id twice", async () => {
  vi.clearAllMocks();
  calls.templates = [template];
  calls.saveTemplate.mockResolvedValue(Exit.succeed(template));
  const dom = render(createElement(TemplateSettings));
  try {
    act(() => button(dom, "Edit").click());
    const values = [...dom.element.querySelectorAll("input")].map((element) => element.value);
    expect(values).toEqual([
      "Greeting",
      "Hello",
      "John <john@example.com>",
      "cc@example.com",
      "bcc@example.com",
    ]);
    act(() => button(dom, "Date").click());
    expect(dom.element.querySelector("textarea")?.value).toBe("Thanks{date}");
    await act(async () => {
      button(dom, "Save").click();
      await Promise.resolve();
    });
    await act(async () => {
      button(dom, "Save").click();
      await Promise.resolve();
    });
    expect(calls.saveTemplate).toHaveBeenCalledTimes(2);
    expect(calls.saveTemplate).toHaveBeenLastCalledWith({
      payload: {
        id: template.id,
        input: {
          name: template.name,
          subject: template.subject,
          to: template.to,
          cc: template.cc,
          bcc: template.bcc,
          body: "Thanks{date}",
        },
      },
      reactivityKeys: ["templates"],
    });
    act(() => button(dom, "Delete").click());
    expect(calls.removeTemplate).toHaveBeenCalledWith({
      payload: { id: template.id },
      reactivityKeys: ["templates"],
    });
  } finally {
    dom.dispose();
  }
});

it("Gmail signature editing creates a sanitized local copy, then updates its id; new/reply defaults are separate", async () => {
  vi.clearAllMocks();
  calls.signatures = [
    {
      id: "gmail:me@example.com",
      source: "gmail",
      address: "me@example.com",
      name: "Gmail",
      text: "Name",
      html: '<b>Name</b><img src="https://tracker.test"><script>bad()</script>',
    },
  ];
  const account: ComponentProps<typeof SignatureSettings>["accounts"][number] = {
    id: "gmail:me@example.com",
    email: "me@example.com",
    provider: "gmail",
    createdAt: 0,
    lastSyncedAt: null,
    lastSyncError: null,
    needsReauth: false,
    profileId: null,
  };
  calls.saveSignature.mockResolvedValue(
    Exit.succeed({ ...calls.signatures[0], id: "local:1", source: "local" }),
  );
  const dom = render(createElement(SignatureSettings, { accounts: [account] }));
  try {
    const menus = [...dom.element.querySelectorAll('div[aria-label*="signature for"]')];
    expect(menus).toHaveLength(2);
    act(() => button(dom, "None", menus[0]).click());
    act(() => button(dom, "Gmail default", menus[1]).click());
    expect(calls.setDefault.mock.calls.map(([input]) => input.payload.setting.kind)).toEqual([
      "new",
      "reply",
    ]);
    act(() => button(dom, "Copy to local signature").click());
    expect(dom.element.querySelector('[aria-label="Signature body"]')?.textContent).toBe(
      "<strong>Name</strong>",
    );
    await act(async () => {
      button(dom, "Save").click();
      await Promise.resolve();
    });
    expect(calls.saveSignature).toHaveBeenLastCalledWith({
      payload: {
        input: {
          address: account.email,
          name: "Gmail copy",
          text: "Name",
          html: "<strong>Name</strong>",
        },
      },
      reactivityKeys: ["signatures"],
    });
    await act(async () => {
      button(dom, "Save").click();
      await Promise.resolve();
    });
    expect(calls.saveSignature.mock.calls[1]?.[0].payload.id).toBe("local:1");
  } finally {
    dom.dispose();
  }
});

it("draft recovery hides pending transient failures, localizes terminal errors and resumes local copies", () => {
  const recover = vi.fn();
  const dom = testDom();
  const mount = (draft: { syncError: string | null; syncRetrying: boolean; localOnly: boolean }) =>
    dom.render(
      createElement(
        I18nProvider,
        { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
        createElement(DraftSyncRecovery, { draft, busy: false, onRecover: recover }),
      ),
    );
  try {
    mount({ syncError: "Private provider detail", syncRetrying: true, localOnly: false });
    expect(dom.element.textContent).not.toContain("Couldn't sync");
    expect(dom.element.querySelector("button")).toBeNull();
    mount({ syncError: "Private provider detail", syncRetrying: false, localOnly: false });
    expect(dom.element.textContent).toContain("Your changes are saved on this Mac");
    expect(dom.element.textContent).not.toContain("Private provider detail");
    mount({ syncError: null, syncRetrying: false, localOnly: true });
    act(() => button(dom, "Resume syncing").click());
    expect(recover).toHaveBeenCalledWith("retry");
  } finally {
    dom.dispose();
  }
});

afterAll(() => {
  vi.doUnmock("@effect/atom-react");
  vi.doUnmock("../../../state/queries");
  vi.doUnmock("../../../state/mutations");
  vi.doUnmock("../../../ui/Select");
  vi.doUnmock("../../compose/components/ComposeEditor");
  vi.resetModules();
});

it("named signatures support drag and keyboard button ordering without changing defaults", () => {
  calls.signatureOrder = [];
  calls.signatures = ["A", "B", "C"].map((name) => ({
    id: name,
    address: "me@example.com",
    name,
    text: name,
    source: "local",
  }));
  calls.setPrefs.mockClear();
  calls.setDefault.mockClear();
  const dom = render(
    createElement(SignatureSettings, {
      accounts: [
        {
          id: "gmail:me@example.com",
          email: "me@example.com",
          provider: "gmail",
          createdAt: 0,
          lastSyncedAt: null,
          profileId: null,
          needsReauth: false,
          lastSyncError: null,
        },
      ],
    }),
  );
  try {
    const up = dom.element.querySelector<HTMLButtonElement>('button[aria-label="Move B up"]');
    act(() => up?.click());
    expect(calls.setPrefs).toHaveBeenLastCalledWith({
      payload: { patch: { signatureOrder: ["B", "A", "C"] } },
      reactivityKeys: ["prefs"],
    });
    const down = dom.element.querySelector<HTMLButtonElement>('button[aria-label="Move B down"]');
    act(() => down?.click());
    expect(calls.setPrefs).toHaveBeenLastCalledWith({
      payload: { patch: { signatureOrder: ["A", "C", "B"] } },
      reactivityKeys: ["prefs"],
    });
    const drag = dom.element.querySelector<HTMLButtonElement>(
      'button[aria-label="Drag C to reorder"]',
    );
    const target = dom.element.querySelector<HTMLButtonElement>(
      'button[aria-label="Drag A to reorder"]',
    )?.parentElement;
    act(() => {
      drag?.dispatchEvent(new dom.window.Event("dragstart", { bubbles: true }));
      target?.dispatchEvent(new dom.window.Event("drop", { bubbles: true, cancelable: true }));
    });
    expect(calls.setPrefs).toHaveBeenLastCalledWith({
      payload: { patch: { signatureOrder: ["C", "A", "B"] } },
      reactivityKeys: ["prefs"],
    });
    expect(calls.setDefault).not.toHaveBeenCalled();
    act(() => button(dom, "Below quoted text").click());
    expect(calls.setPrefs).toHaveBeenLastCalledWith({
      payload: { patch: { signaturePosition: "below" } },
      reactivityKeys: ["prefs"],
    });
  } finally {
    dom.dispose();
  }
});
