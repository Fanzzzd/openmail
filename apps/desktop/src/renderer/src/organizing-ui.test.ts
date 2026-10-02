import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { AsyncResult } from "effect/reactivity";
import {
  EMPTY_FILTER,
  EMPTY_VACATION,
  type ServerFilter,
  type FilterRestoration,
  type Label,
} from "@openmail/core/schema";
import { testDom } from "./test-dom";

const calls = vi.hoisted(() => ({
  prepare: vi.fn(),
  prepareRestoration: vi.fn(),
  discard: vi.fn(),
  create: vi.fn(),
  apply: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
  filters: new Array<ServerFilter>(),
  backups: new Array<FilterRestoration>(),
  labels: new Array<Label>(),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtom: (tag: string) => [
    AsyncResult.success(undefined),
    tag === "prepareRestoration"
      ? calls.prepareRestoration
      : tag === "discard"
        ? calls.discard
        : tag === "prepare"
          ? calls.prepare
          : tag === "create"
            ? calls.create
            : tag === "delete"
              ? calls.remove
              : tag === "restore"
                ? calls.restore
                : tag === "apply"
                  ? calls.apply
                  : vi.fn(),
  ],
  useAtomValue: (tag: string) =>
    tag === "labels"
      ? AsyncResult.success(calls.labels)
      : tag === "filters"
        ? AsyncResult.success(calls.filters)
        : tag === "vacation"
          ? AsyncResult.success(EMPTY_VACATION)
          : tag === "FilterRestorations"
            ? AsyncResult.success(calls.backups)
            : AsyncResult.success([]),
}));
vi.mock("./state/queries", () => ({
  labelPreferencesAtom: "preferences",
  organizationAtom: "organization",
  filtersListAtom: () => "filters",
  vacationAtom: () => "vacation",
  labelsAtom: () => "labels",
  sendAsAtom: "aliases",
}));
vi.mock("./state/mutations", () => ({
  changeLabelAtom: "changeLabel",
  setLabelPreferenceAtom: "setLabelPreference",
  setOrganizationAtom: "setOrganization",
  prepareFilterAtom: "prepare",
  createFilterAtom: "create",
  deleteFilterAtom: "delete",
  restoreFilterAtom: "restore",
  prepareFilterRestorationAtom: "prepareRestoration",
  discardFilterRestorationAtom: "discard",
  updateFilterAtom: "update",
  applyFilterAtom: "apply",
  reauthAtom: () => "reauth",
  setVacationAtom: "vacation",
  syncSendAsAtom: "sync",
}));
vi.mock("./rpc", () => ({
  MailClient: { query: (name: string) => name, mutation: (name: string) => name },
}));
vi.mock("./components/ContactSettings", () => ({ ContactSettings: () => null }));
vi.mock("./components/ui/Dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => createElement("section", null, children),
  Alert: ({
    open,
    title,
    description,
    children,
  }: {
    open: boolean;
    title: string;
    description: string;
    children: ReactNode;
  }) =>
    open ? createElement("section", { role: "alertdialog" }, title, description, children) : null,
  AlertCancel: ({ children }: { children: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  alertDanger: "",
}));
vi.mock("./components/ui/Checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) =>
    createElement("button", {
      type: "button",
      role: "checkbox",
      "aria-checked": checked,
      onClick: () => onCheckedChange(!checked),
    }),
}));
vi.mock("./components/ui/Select", () => ({
  Select: ({
    options,
    onValueChange,
    ...props
  }: {
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
    "aria-label": string;
  }) =>
    createElement(
      "div",
      { "aria-label": props["aria-label"] },
      options.map((option) =>
        createElement(
          "button",
          { key: option.value, type: "button", onClick: () => onValueChange(option.value) },
          option.label,
        ),
      ),
    ),
}));

import { FilterEditor, ServerSettings } from "./components/ServerSettings";
import { LabelEditor } from "./components/OrganizationSettings";

const account = {
  id: "gmail:me",
  provider: "gmail",
  email: "me@example.com",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
} as const;
function render(node: ReactNode) {
  calls.prepare.mockResolvedValue({
    _tag: "Success",
    value: { token: "preview-token", matches: [], truncated: false },
  });
  calls.prepareRestoration.mockResolvedValue({
    _tag: "Success",
    value: { kind: "preview", preview: { token: "preview-token", matches: [], truncated: false } },
  });
  calls.discard.mockResolvedValue({ _tag: "Success" });
  calls.apply.mockResolvedValue({ _tag: "Success" });
  calls.restore.mockResolvedValue({ _tag: "Success" });
  calls.create.mockResolvedValue({ _tag: "Success" });
  calls.remove.mockResolvedValue({ _tag: "Success" });
  const dom = testDom();
  dom.render(
    createElement(I18nProvider, { i18n: setupI18n({ locale: "en", messages: {} }) }, node),
  );
  return dom;
}

it("a non-editable rule can be deleted through plain confirmation without preview", async () => {
  vi.clearAllMocks();
  calls.filters = [
    {
      ...EMPTY_FILTER,
      id: "category",
      name: "Category",
      editable: false,
      action: { ...EMPTY_FILTER.action, label: "CATEGORY_UPDATES" },
    },
  ];
  const dom = render(createElement(ServerSettings, { accounts: [account] }));
  try {
    const remove = [...dom.element.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    );
    expect(remove).toBeDefined();
    expect(remove?.hasAttribute("disabled")).toBe(false);
    act(() => remove?.click());
    expect(calls.remove).not.toHaveBeenCalled();
    expect(calls.prepare).not.toHaveBeenCalled();
    const confirmation = [
      ...dom.element.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((button) => button.textContent === "Delete");
    await act(async () => {
      confirmation?.click();
    });
    expect(calls.remove).toHaveBeenCalledWith({
      payload: { accountId: account.id, id: "category", confirmed: true },
      reactivityKeys: expect.any(Array),
    });
  } finally {
    dom.dispose();
  }
});

for (const deletion of [true, false]) {
  it(`rule confirmation ${deletion ? "shows the deletion warning and then sets" : "omits"} the query deletion flag`, async () => {
    vi.clearAllMocks();
    const initial = {
      ...EMPTY_FILTER,
      id: "rule",
      criteria: { ...EMPTY_FILTER.criteria, query: "from:alice" },
      action: { ...EMPTY_FILTER.action, trash: deletion, markRead: !deletion },
    };
    const editor = render(
      createElement(FilterEditor, { account, initial, mode: "apply", onClose: vi.fn() }),
    );
    try {
      const form = editor.element.querySelector("form");
      expect(form).not.toBeNull();
      await act(async () => {
        form?.dispatchEvent(new editor.window.Event("submit", { bubbles: true, cancelable: true }));
      });
      const alert = editor.element.querySelector('[role="alertdialog"]');
      expect(
        alert?.textContent.includes("This rule deletes messages matching a search query."),
      ).toBe(deletion);
      expect(calls.apply).not.toHaveBeenCalled();
      const confirm = [
        ...editor.element.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
      ].find((button) => button.textContent === "Confirm");
      await act(async () => {
        confirm?.click();
      });
      expect(calls.prepare).toHaveBeenCalledWith({
        payload: {
          accountId: account.id,
          input: { name: initial.name, criteria: initial.criteria, action: initial.action },
        },
      });
      expect(calls.apply).toHaveBeenCalledWith({
        payload: {
          accountId: account.id,
          input: {
            name: initial.name,
            criteria: initial.criteria,
            action: initial.action,
            ...(deletion ? { queryDeletionConfirmed: true } : {}),
          },
          token: "preview-token",
        },
        reactivityKeys: expect.any(Array),
      });
    } finally {
      editor.dispose();
    }
  });
}

it("LabelEditor trims a name before submitting it", async () => {
  const saved = vi.fn();
  const dom = render(
    createElement(LabelEditor, {
      label: { id: "old", accountId: account.id, name: "  Work  ", color: null },
      labels: [],
      busy: false,
      error: null,
      onSave: saved,
      onClose: vi.fn(),
    }),
  );
  try {
    const form = dom.element.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(saved).toHaveBeenCalledWith({ kind: "rename", id: "old", name: "Work" });
  } finally {
    dom.dispose();
  }
});

it("saved rule recovery exposes Restore rule and waits for a preview confirmation", async () => {
  vi.clearAllMocks();
  calls.filters = [];
  calls.backups = [
    {
      id: "backup",
      accountId: account.id,
      originalId: "old",
      input: {
        ...EMPTY_FILTER,
        name: "Original",
        criteria: { ...EMPTY_FILTER.criteria, from: "alice" },
        action: { ...EMPTY_FILTER.action, markRead: true },
      },
      definition: { criteria: { from: "alice" }, action: { removeLabelIds: ["UNREAD"] } },
    },
  ];
  const dom = render(createElement(ServerSettings, { accounts: [account] }));
  try {
    const button = [...dom.element.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore rule",
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(calls.restore).not.toHaveBeenCalled();
    expect(dom.element.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Preview: 0 messages.",
    );
    const confirm = [
      ...dom.element.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((item) => item.textContent === "Restore rule");
    await act(async () => {
      confirm?.click();
    });
    expect(calls.restore).toHaveBeenCalledWith({
      payload: { accountId: account.id, id: "backup", token: "preview-token" },
      reactivityKeys: expect.any(Array),
    });
  } finally {
    calls.backups = [];
    dom.dispose();
  }
});

for (const provider of ["gmail", "outlook"] as const) {
  it(`${provider}: archive and label controls ${provider === "gmail" ? "can both be selected" : "remain mutually exclusive"}`, async () => {
    vi.clearAllMocks();
    calls.labels = [{ id: "Label_1", name: "Target", color: null, accountId: account.id }];
    const input = {
      ...EMPTY_FILTER,
      id: "rule",
      name: "Rule",
      criteria: { ...EMPTY_FILTER.criteria, from: "alice" },
      action: { ...EMPTY_FILTER.action, markRead: true },
    };
    const dom = render(
      createElement(FilterEditor, {
        account: { ...account, provider },
        initial: input,
        onClose: vi.fn(),
      }),
    );
    try {
      const target = () =>
        [
          ...dom.element.querySelectorAll<HTMLButtonElement>(
            '[aria-label="Label or folder"] button',
          ),
        ].find((button) => button.textContent === "Target");
      act(() => {
        target()?.click();
      });
      const archive = [...dom.element.querySelectorAll("label")]
        .find((label) => label.textContent === "Archive")
        ?.querySelector("button");
      act(() => {
        archive?.click();
      });
      act(() => {
        target()?.click();
      });
      const form = dom.element.querySelector("form");
      await act(async () => {
        form?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(calls.prepare).toHaveBeenCalledWith({
        payload: {
          accountId: account.id,
          input: {
            name: "Rule",
            criteria: input.criteria,
            action: { ...input.action, label: "Label_1", archive: provider === "gmail" },
          },
        },
      });
    } finally {
      calls.labels = [];
      dom.dispose();
    }
  });
}

it("Restore clears an already existing rule without opening a creation confirmation", async () => {
  vi.clearAllMocks();
  calls.backups = [
    { id: "backup", accountId: account.id, originalId: "old", input: EMPTY_FILTER, definition: {} },
  ];
  const dom = render(createElement(ServerSettings, { accounts: [account] }));
  calls.prepareRestoration.mockResolvedValueOnce({ _tag: "Success", value: { kind: "complete" } });
  try {
    const button = [...dom.element.querySelectorAll("button")].find(
      (item) => item.textContent === "Restore rule",
    );
    await act(async () => {
      button?.click();
    });
    expect(calls.prepareRestoration).toHaveBeenCalledWith({
      payload: { accountId: account.id, id: "backup" },
      reactivityKeys: expect.any(Array),
    });
    expect(dom.element.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calls.prepare).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
  } finally {
    calls.backups = [];
    dom.dispose();
  }
});

it("Discard recovery requires confirmation and does not prepare or restore a server rule", async () => {
  vi.clearAllMocks();
  calls.backups = [
    { id: "backup", accountId: account.id, originalId: "old", input: EMPTY_FILTER, definition: {} },
  ];
  const dom = render(createElement(ServerSettings, { accounts: [account] }));
  try {
    const button = [...dom.element.querySelectorAll("button")].find(
      (item) => item.textContent === "Discard",
    );
    act(() => {
      button?.click();
    });
    expect(calls.discard).not.toHaveBeenCalled();
    expect(dom.element.querySelector('[role="alertdialog"]')?.textContent).toContain(
      "Rules on the server are unchanged.",
    );
    const confirm = [
      ...dom.element.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button'),
    ].find((item) => item.textContent === "Discard");
    await act(async () => {
      confirm?.click();
    });
    expect(calls.discard).toHaveBeenCalledWith({
      payload: { accountId: account.id, id: "backup", confirmed: true },
      reactivityKeys: expect.any(Array),
    });
    expect(calls.prepareRestoration).not.toHaveBeenCalled();
    expect(calls.restore).not.toHaveBeenCalled();
  } finally {
    calls.backups = [];
    dom.dispose();
  }
});
