import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DEFAULT_PREFS, type Account, type Prefs, type ThreadSummary } from "@openmail/core/schema";
import type { Effect } from "effect";
import { act, createElement, useEffect, useRef, useState } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../../shared/desktop";
import type { ToastState } from "../components/Toast";
import { emptyDraft, toDraftInput } from "../draft";
import { useRunMail } from "../state/mail";
import type { ThreadList } from "../state/threads";
import { testDom } from "../test-dom";
import { ALL, OVERVIEW } from "../view";
import { testMessages as messages } from "./test-messages";
import { useAppPanels, usePanelLayout } from "./use-app-panels";
import { useMailActions } from "./use-mail-actions";
import { useMailCompose } from "./use-mail-compose";
import { useMailSelection } from "./use-mail-selection";
import { useMailShortcuts } from "./use-mail-shortcuts";
import { useNativeMenuBridge } from "./use-native-menu-bridge";
import { usePaneNavigation } from "./use-pane-navigation";

const state = vi.hoisted(() => {
  vi.resetModules();
  return {
    accounts: new Array<Account>(),
    prefs: vi.fn<() => Prefs>(),
    threads: vi.fn<() => ThreadList>(),
    search: "",
    calls: new Array<{ tag: string; payload: unknown }>(),
    operations: vi.fn(),
    loadMore: vi.fn(),
    emit: vi.fn<(event: DesktopEvent) => void>(),
    fail: false,
    layout: vi.fn(),
    page: new Array<ThreadSummary>(),
    deferred: false,
    wait: vi.fn<() => Promise<void>>(),
    delivered: vi.fn(),
    saveGate: vi.fn<() => Promise<void>>(),
  };
});
vi.mock("@effect/atom-react", async () => {
  const { useState } = await import("react");
  const { AsyncResult } = await import("effect/reactivity");
  const { DEFAULT_LIST_FILTERS } = await import("@openmail/core/schema");
  return {
    useAtom: (atom: string) => {
      const initial =
        atom === "view"
          ? { space: "all", mailbox: "inbox" }
          : atom === "filters"
            ? DEFAULT_LIST_FILTERS
            : "";
      const pair = useState(initial);
      return atom === "threads" ? [state.threads(), state.loadMore] : pair;
    },
    useAtomValue: (atom: string) =>
      atom === "prefs"
        ? AsyncResult.success(state.prefs())
        : atom === "accounts"
          ? AsyncResult.success(state.accounts)
          : atom === "remembered"
            ? new Map([["profile", { space: "profile", mailbox: "sent" }]])
            : atom === "query"
              ? { mailbox: "inbox", flat: !state.prefs().threadGrouping }
              : atom === "search"
                ? state.search
                : AsyncResult.initial(),
  };
});
vi.mock("../state/queries", () => ({
  accountsAtom: "accounts",
  prefsAtom: "prefs",
  sendAsAtom: "aliases",
  threadAtom: () => "thread",
}));
vi.mock("../state/threads", () => ({ threadListAtom: "threads", listQueryAtom: "query" }));
vi.mock("../state/ui", () => ({
  viewAtom: "view",
  rememberedViewsAtom: "remembered",
  searchTextAtom: "text",
  searchScopeAtom: "scope",
  searchAtom: "search",
  filtersAtom: "filters",
}));
vi.mock("../state/events", () => ({ syncStateAtom: "sync", syncProgressAtom: "progress" }));
vi.mock("../state/mail", async () => {
  const { Effect } = await import("effect");
  const { InvalidInput } = await import("@openmail/core/schema");
  return {
    useRunMail: () => Effect.runFork,
    withMail: (
      f: (
        call: (tag: string, payload: unknown) => Effect.Effect<unknown>,
      ) => Effect.Effect<unknown>,
    ) =>
      f((tag, payload) =>
        Effect.sync(() => {
          state.calls.push({ tag, payload });
          if (tag === "ClaimInlineDraft") return true;
          if (tag === "Threads") return state.page;
          if (tag === "Thread") return [];
          if (tag === "Accounts") return state.accounts;
          return false;
        }),
      ),
    modifyWithUndo: (ids: readonly string[], op: unknown, flat: boolean) => {
      state.operations(ids, op, flat);
      if (state.deferred)
        return Effect.promise(() => state.wait()).pipe(Effect.as({ undoId: "undo" }));
      return state.fail
        ? Effect.fail(new InvalidInput({ message: "failure" }))
        : Effect.succeed({ undoId: "undo" });
    },
    saveDraft: () => Effect.promise(() => state.saveGate()),
    sendMessage: (...args: unknown[]) =>
      Effect.sync(() => {
        state.delivered(...args);
      }),
    discardDraft: () => Effect.void,
    openDraft: () => Effect.succeed(null),
    draftStatus: () => Effect.succeed(null),
    openThreadWindow: () => Effect.void,
    syncNow: Effect.void,
  };
});
vi.mock("../state/desktop", () => ({
  useDesktopEvents: (receive: (event: DesktopEvent) => void) => {
    state.emit.mockImplementation(receive);
  },
}));
vi.mock("react-resizable-panels", () => ({
  useDefaultLayout: (options: unknown) => {
    state.layout(options);
    return { defaultLayout: undefined, onLayoutChanged: vi.fn() };
  },
}));

const account: Account = {
  id: "a",
  email: "me@example.com",
  provider: "gmail",
  createdAt: 0,
  lastSyncedAt: null,
  lastSyncError: null,
  profileId: null,
  needsReauth: false,
};
const row = (id: string): ThreadSummary => ({
  id,
  accountId: "a",
  threadId: id,
  threadCount: 1,
  participants: [],
  from: { name: "Alice", address: "alice@example.com" },
  subject: id,
  snippet: "",
  date: 10,
  labels: ["INBOX"],
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
});
const notify = vi.fn<(toast: Omit<ToastState, "id">) => void>();
const showUndo = vi.fn();
let undo: (() => void) | null = null;
function Harness() {
  const run = useRunMail();
  const panels = useAppPanels();
  const navigation = useMailSelection({
    messages,
    setLabelPicker: panels.setLabelPicker,
    accountsReady: true,
    accountList: state.accounts,
    run,
    composeId: undefined,
    say: notify,
  });
  const undoRef = useRef<(() => void) | null>(null);
  const [, setToast] = useState<ToastState | null>(null);
  const composition = useMailCompose({
    messages,
    panels,
    navigation,
    run,
    composeId: undefined,
    accountList: state.accounts,
    signatures: [],
    say: notify,
    readerSelection: null,
    currentReaderThreadKey: null,
    undoRef,
    setToast,
  });
  const mailActions = useMailActions({
    messages,
    navigation,
    panels,
    accountList: state.accounts,
    labels: [],
    run,
    say: notify,
    showUndo,
    selectedAccount: account,
  });
  const panes = usePaneNavigation({ layout: panels.layout, navigation, run });
  useMailShortcuts({
    panels,
    navigation,
    panes,
    mailActions,
    composition,
    run,
    profileList: [],
    favorites: [],
    undoRef,
    openWindow: navigation.openWindow,
    threadState: null,
    print: vi.fn(),
  });
  useNativeMenuBridge({
    messages,
    panels,
    navigation,
    composition,
    run,
    threadState: null,
    say: notify,
    accountList: state.accounts,
    undoRef,
    openExternal: navigation.openExternal,
  });
  useEffect(() => {
    model = { panels, navigation, mailActions, composition };
  });
  return null;
}
let model: {
  panels: ReturnType<typeof useAppPanels>;
  navigation: ReturnType<typeof useMailSelection>;
  mailActions: ReturnType<typeof useMailActions>;
  composition: ReturnType<typeof useMailCompose>;
};
let dom: ReturnType<typeof testDom>;
const mount = () =>
  dom.render(
    createElement(
      I18nProvider,
      { i18n: setupI18n({ locale: "en", messages: { en: {} } }) },
      createElement(Harness),
    ),
  );
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
const key = (value: string, target: EventTarget = dom.window, modifiers = {}) => {
  const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, {
    key: value,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  });
  void act(() => target.dispatchEvent(event));
  return event;
};
beforeEach(() => {
  state.accounts = [account];
  state.prefs.mockReturnValue({ ...DEFAULT_PREFS, markReadDelay: "manual", shortcutSet: "gmail" });
  state.threads.mockReturnValue({
    threads: [row("one"), row("two"), row("three")],
    loading: false,
    loadingMore: false,
    canLoadMore: false,
    exhausted: true,
    loadError: false,
    moreNotLoaded: null,
    searchingServer: false,
    searchTruncated: false,
    searchErrors: [],
    searchIgnored: [],
  });
  state.calls = [];
  state.search = "";
  state.fail = false;
  state.page = [];
  state.deferred = false;
  state.delivered.mockClear();
  state.saveGate.mockResolvedValue();
  state.operations.mockClear();
  state.loadMore.mockClear();
  state.layout.mockClear();
  notify.mockClear();
  showUndo.mockClear();
  undo = null;
  showUndo.mockImplementation((_result, _ids, _text, restore) => {
    undo = restore;
  });
  dom = testDom();
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  mount();
});
afterEach(() => dom.dispose());

it("selection reconciles removals and query changes, and remembered spaces reset search", () => {
  act(() => model.navigation.selectRow("two", { toggle: false, range: false }));
  expect(model.navigation.selectedId).toBe("two");
  state.threads.mockReturnValue({ ...state.threads(), threads: [row("one"), row("three")] });
  mount();
  expect(model.navigation.selectedId).toBeNull();
  act(() => {
    model.navigation.setQuery("hello");
    model.navigation.switchSpace("profile");
  });
  expect(model.navigation.view).toEqual({ space: "profile", mailbox: "sent" });
  expect(model.navigation.query).toBe("");
  act(() => model.navigation.selectRow("one", { toggle: false, range: false }));
  state.search = "different";
  mount();
  expect(model.navigation.selection.ids.size).toBe(0);
});

it("archive advances selection and Undo restores it, while an in-flight operation cannot override navigation", async () => {
  act(() => model.navigation.select("two", "mouse"));
  act(() => model.mailActions.act({ kind: "archive" }));
  await flush();
  expect(state.operations).toHaveBeenCalledWith(["two"], { kind: "archive" }, false);
  expect(model.navigation.selectedId).toBe("three");
  act(() => undo?.());
  expect(model.navigation.selectedId).toBe("two");
  let settle: () => void = vi.fn();
  state.deferred = true;
  state.wait.mockReturnValue(
    new Promise<void>((resolve) => {
      settle = resolve;
    }),
  );
  act(() => {
    model.mailActions.act({ kind: "archive" });
    model.navigation.select("one", "mouse");
  });
  settle();
  await flush();
  state.deferred = false;
  expect(model.navigation.selectedId).toBe("one");
  state.fail = true;
  act(() => model.mailActions.act({ kind: "star", value: true }));
  await flush();
  expect(notify.mock.calls.at(-1)?.[0].tone).toBe("error");
  expect(model.navigation.selectedId).toBe("one");
});

it("keyboard owns typing and modal guards and dispatches the current keymap", async () => {
  act(() => model.navigation.select("one", "mouse"));
  const input = dom.window.document.createElement("input");
  dom.window.document.body.append(input);
  key("e", input);
  await flush();
  expect(state.operations).not.toHaveBeenCalled();
  act(() => model.panels.setDialog("settings"));
  key("e");
  await flush();
  expect(state.operations).not.toHaveBeenCalled();
  act(() => model.panels.setDialog(null));
  expect(key("e").defaultPrevented).toBe(true);
  await flush();
  expect(model.navigation.selectedId).toBe("two");
  state.prefs.mockReturnValue({ ...state.prefs(), shortcutSet: "apple" });
  mount();
  key("e");
  await flush();
  expect(state.operations).toHaveBeenCalledTimes(1);
  key("a", dom.window, { metaKey: true });
  expect(model.navigation.selection.ids.size).toBe(3);
});

it("native bridge defers search while a dialog is open and updates menu state", async () => {
  act(() => {
    model.navigation.select("one", "mouse");
    model.panels.setDialog("settings");
  });
  await flush();
  expect(state.calls.filter((call) => call.tag === "SetNativeMenuState").at(-1)?.payload).toEqual({
    state: { selected: false, composing: false, gmail: false },
  });
  act(() => state.emit({ _tag: "Search", query: "deferred" }));
  expect(model.navigation.query).toBe("");
  act(() => model.panels.setDialog(null));
  await flush();
  await flush();
  expect(model.navigation.query).toBe("deferred");
  expect(model.navigation.view).toEqual({ space: ALL, mailbox: "all" });
});

it("panels keep independent state and layout persistence follows overview and sidebar preferences", () => {
  act(() => {
    model.panels.setGoToFolder(true);
    model.panels.setPickerMode("move");
  });
  expect(model.panels.goToFolder).toBe(true);
  expect(model.panels.pickerMode).toBe("move");
  expect(model.panels.dialog).toBeNull();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  function LayoutHarness() {
    usePanelLayout({
      prefs: { ...DEFAULT_PREFS, sidebarVisible: false },
      hasAccounts: true,
      view: { space: OVERVIEW, mailbox: "inbox" },
      mode: "wide",
    });
    return null;
  }
  dom.render(createElement(LayoutHarness));
  expect(state.layout).toHaveBeenCalledWith(
    expect.objectContaining({ id: expect.stringContaining("overview"), panelIds: ["main"] }),
  );
});

it("removing the last loaded row waits for the next page before advancing selection", async () => {
  state.threads.mockReturnValue({ ...state.threads(), canLoadMore: true });
  mount();
  state.page = [row("four")];
  act(() => model.navigation.select("three", "keyboard"));
  act(() => model.mailActions.act({ kind: "archive" }));
  await flush();
  await flush();
  expect(state.loadMore).toHaveBeenCalled();
  state.threads.mockReturnValue({
    ...state.threads(),
    threads: [row("one"), row("two"), row("four")],
  });
  mount();
  await flush();
  expect(model.navigation.selectedId).toBe("four");
});

it("compose claims an inline draft and quietly closes an unchanged draft", async () => {
  const draft = emptyDraft(account.id);
  act(() => model.composition.setCompose(draft));
  await flush();
  expect(model.composition.compose).toEqual(draft);
  expect(state.calls).toContainEqual({ tag: "ClaimInlineDraft", payload: { id: draft.id } });
  act(() => model.composition.closeCompose(draft, false));
  await flush();
  expect(model.composition.compose).toBeNull();
});

it("delivery Undo cancels send, and send-and-archive waits for saving before advancing selection", async () => {
  vi.useFakeTimers();
  try {
    state.prefs.mockReturnValue({ ...state.prefs(), undoSendSeconds: 5 });
    mount();
    const draft = {
      ...emptyDraft(account.id),
      mode: "reply" as const,
      inReplyTo: "one",
      to: "alice@example.com",
      subject: "Reply",
    };
    const message = toDraftInput(draft).message;
    act(() => model.navigation.select("one", "mouse"));
    act(() => model.composition.send(draft, message, { archive: true }));
    expect(model.composition.hasPendingSends()).toBe(true);
    act(() => model.composition.undoSend());
    await flush();
    expect(model.composition.compose).toEqual(draft);
    expect(model.composition.hasPendingSends()).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(state.delivered).not.toHaveBeenCalled();
    let saved: () => void = vi.fn();
    state.saveGate.mockReturnValue(
      new Promise<void>((resolve) => {
        saved = resolve;
      }),
    );
    act(() => model.composition.send(draft, message, { archive: true }));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(state.delivered).not.toHaveBeenCalled();
    saved();
    await flush();
    await flush();
    expect(state.delivered).toHaveBeenCalledWith(account.id, message, {
      draftId: draft.id,
      archive: true,
    });
    expect(model.navigation.selectedId).toBe("two");
    expect(model.composition.hasPendingSends()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

afterAll(() => {
  for (const name of [
    "@effect/atom-react",
    "../state/queries",
    "../state/threads",
    "../state/ui",
    "../state/events",
    "../state/mail",
    "../state/desktop",
    "react-resizable-panels",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});

it("label changes keep selection, bulk Trash requires captured confirmation, and snooze offers Undo", async () => {
  act(() => model.navigation.select("one", "mouse"));
  act(() => model.mailActions.act({ kind: "label", labelId: "custom", value: true }));
  await flush();
  expect(model.navigation.selectedId).toBe("one");
  expect(showUndo).toHaveBeenCalledWith(
    { undoId: "undo" },
    ["one"],
    "Label added",
    expect.any(Function),
  );
  state.threads.mockReturnValue({
    ...state.threads(),
    threads: Array.from({ length: 51 }, (_, index) => row(String(index))),
  });
  mount();
  act(() => model.navigation.selectAll());
  state.operations.mockClear();
  act(() => model.mailActions.act({ kind: "trash" }));
  expect(state.operations).not.toHaveBeenCalled();
  expect(model.navigation.deleteRequest?.ids.size).toBe(51);
  const confirmedIds = model.navigation.deleteRequest?.ids;
  act(() => model.mailActions.act({ kind: "trash" }, { confirmedIds }));
  await flush();
  expect(state.operations).toHaveBeenCalledWith(
    Array.from({ length: 51 }, (_, index) => String(index)),
    { kind: "trash" },
    false,
  );
  act(() => {
    model.navigation.select("0", "mouse");
    model.panels.setSnoozeIds(["0"]);
  });
  let finish: ReturnType<typeof model.mailActions.startSnooze>;
  act(() => {
    finish = model.mailActions.startSnooze();
  });
  act(() => finish({ undoId: "snooze" }));
  expect(showUndo).toHaveBeenCalledWith(
    { undoId: "snooze" },
    ["0"],
    "Snoozed",
    expect.any(Function),
  );
  expect(model.panels.snoozeIds).toBeNull();
  await flush();
  expect(model.navigation.selectedId).toBe("1");
});
