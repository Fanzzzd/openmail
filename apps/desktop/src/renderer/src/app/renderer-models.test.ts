import type { MailOp } from "../../../shared/api";
import type { AppMessages } from "./use-app-messages";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { DEFAULT_PREFS, type Account, type Prefs, type ThreadSummary } from "@openmail/core/schema";
import type { Effect } from "effect";
import { act, createElement, useEffect, useRef, useState } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopEvent } from "../../../shared/desktop";
import type { ToastState } from "../ui/Toast";
import { rememberSearchReturn } from "../features/search/search-return";
import { emptyDraft, toDraftInput } from "../features/compose/draft";
import { useRunMail } from "../state/mail";
import type { ThreadList } from "../state/threads";
import { testDom } from "../test-support/test-dom";
import { ALL, OVERVIEW } from "../lib/view";
import { usePanelLayout } from "./use-panel-layout";
import { useMailLayout } from "../lib/responsive-layout";
import { pickerModeAtom, snoozeIdsAtom } from "../features/organize/organize-state";
import { goToFolderAtom } from "../features/sidebar/go-to-folder";
import { dialogAtom } from "../state/ui";
import { type Atom, AtomRegistry } from "effect/reactivity";
import { useMailActions } from "./use-mail-actions";
import { useMailCompose } from "./use-mail-compose";
import { useMailSelection } from "./use-mail-selection";
import { useMailShortcuts } from "./use-mail-shortcuts";
import { useNativeMenuBridge } from "./use-native-menu-bridge";
import { usePaneNavigation } from "./use-pane-navigation";
import { forwardFrameKey } from "../features/reader/frame/forward-frame-key";
import { parseHTML } from "linkedom";

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
    page: new Array<ThreadSummary>(),
    deferred: false,
    wait: vi.fn<() => Promise<void>>(),
    delivered: vi.fn(),
    saveGate: vi.fn<() => Promise<void>>(),
    cancelGate: vi.fn<() => Promise<void>>(),
    cancelResult: vi.fn<() => "success" | "false" | "failure">(() => "success"),
    deliveryFailure: false,
    uncertain: false,
    confirms: new Array<(confirmed: boolean) => void>(),
    toastUpdates: vi.fn<(value: unknown) => void>(),
  };
});
vi.mock("@effect/atom-react", async () => {
  const { createContext, useCallback, useState, useSyncExternalStore } = await import("react");
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const { DEFAULT_LIST_FILTERS } = await import("@openmail/core/schema");
  const unused = Atom.make<unknown>(null);
  // Real atoms (panel state) share one registry per test; string stand-ins are per hook.
  // Both hooks run on every call so the hook order never depends on the atom.
  const useReal = (atom: string | Atom.Atom<unknown>) => {
    const real = typeof atom === "string" ? unused : atom;
    return useSyncExternalStore(
      useCallback((notify: () => void) => registry.subscribe(real, notify), [real]),
      () => registry.get(real),
    );
  };
  const setReal = (atom: Atom.Writable<unknown, unknown>) => (value: unknown) =>
    registry.set(atom, typeof value === "function" ? value(registry.get(atom)) : value);
  const initial = (atom: string) =>
    atom === "view"
      ? { space: "all", mailbox: "inbox" }
      : atom === "filters"
        ? DEFAULT_LIST_FILTERS
        : atom === "openThread"
          ? null
          : "";
  const fake = (atom: string) =>
    atom === "commit"
      ? state.search
      : atom === "prefs"
        ? AsyncResult.success(state.prefs())
        : atom === "accounts"
          ? AsyncResult.success(state.accounts)
          : atom === "remembered"
            ? new Map([["profile", { space: "profile", mailbox: "sent" }]])
            : atom === "query"
              ? { mailbox: "inbox", flat: !state.prefs().threadGrouping }
              : atom === "search"
                ? state.search
                : AsyncResult.initial();
  return {
    // The panes read the route at call time through the registry.
    RegistryContext: createContext({ get: (atom: Atom.Atom<unknown>) => registry.get(atom) }),
    useAtom: (atom: string | Atom.Writable<unknown, unknown>) => {
      const shared = useReal(atom);
      const pair = useState(typeof atom === "string" ? initial(atom) : null);
      if (typeof atom !== "string") return [shared, setReal(atom)];
      return atom === "threads" ? [state.threads(), state.loadMore] : pair;
    },
    useAtomSet: (atom: string | Atom.Writable<unknown, unknown>) =>
      typeof atom === "string" ? vi.fn() : setReal(atom),
    useAtomValue: (atom: string | Atom.Atom<unknown>) => {
      const shared = useReal(atom);
      return typeof atom === "string" ? fake(atom) : shared;
    },
  };
});
vi.mock("../state/queries", () => ({
  accountsAtom: "accounts",
  prefsAtom: "prefs",
  sendAsAtom: "aliases",
  threadAtom: () => "thread",
}));
vi.mock("../state/threads", () => ({ threadListAtom: "threads", listQueryAtom: "query" }));
vi.mock("../state/ui", async () => ({
  viewAtom: "view",
  searchTextAtom: "text",
  searchScopeAtom: "scope",
  searchAtom: "search",
  commitSearchAtom: "commit",
  dialogAtom: (await import("effect/reactivity")).Atom.make<string | null>(null),
  signInAgainAtom: (await import("effect/reactivity")).Atom.make<string | null>(null),
  openThreadAtom: "openThread",
  openMessageAtom: "openMessage",
  filtersAtom: "filters",
}));
vi.mock("../state/location", async (original) => ({
  ...(await original<typeof import("../state/location")>()),
  rememberedViewsAtom: "remembered",
}));
vi.mock("../state/events", () => ({ syncStateAtom: "sync", syncProgressAtom: "progress" }));
vi.mock("../state/mail", async () => {
  const { Effect, Schema } = await import("effect");
  const { InvalidInput, ProviderError, DraftInput, SendUncertain } =
    await import("@openmail/core/schema");
  const queuedSchema = Schema.Struct({
    draft: DraftInput,
    due: Schema.Number,
    archive: Schema.Boolean,
  });
  const queued = new Map<string, typeof queuedSchema.Type>();
  return {
    useRunMail: () => Effect.runFork,
    withMail: (
      f: (
        call: (
          tag: string,
          payload: unknown,
        ) => Effect.Effect<
          unknown,
          InstanceType<typeof InvalidInput> | InstanceType<typeof ProviderError>
        >,
      ) => Effect.Effect<
        unknown,
        InstanceType<typeof InvalidInput> | InstanceType<typeof ProviderError>
      >,
    ) =>
      f((tag, payload) => {
        if (tag === "QueueUndoSend")
          return Effect.promise(() => state.saveGate()).pipe(
            Effect.andThen(
              Effect.sync(() => {
                state.calls.push({ tag, payload });
                const item = Schema.decodeUnknownSync(queuedSchema)(payload);
                queued.set(item.draft.id, item);
              }),
            ),
          );
        if (tag === "CancelWaitingSend")
          return Effect.promise(() => state.cancelGate()).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                state.calls.push({ tag, payload });
                const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
                  payload,
                );
                if (state.cancelResult() === "failure")
                  return Effect.fail(new InvalidInput({ message: "Cancel failed" }));
                return Effect.succeed(state.cancelResult() === "success" && queued.delete(id));
              }),
            ),
          );
        if (tag === "AwaitUndoSend")
          return Effect.gen(function* () {
            const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(payload);
            const item = queued.get(id);
            if (!item) return yield* new InvalidInput({ message: "Cancelled" });
            if (item.due > Date.now())
              yield* Effect.promise(
                () =>
                  new Promise<void>((resolve) => {
                    setTimeout(resolve, item.due - Date.now());
                  }),
              );
            if (queued.get(id) !== item) return yield* new InvalidInput({ message: "Cancelled" });
            queued.delete(id);
            if (state.deliveryFailure)
              return yield* new ProviderError({ message: "Delivery failed" });
            state.delivered(item.draft.accountId, item.draft.message, {
              draftId: id,
              archive: item.archive,
            });
            return yield* Effect.void;
          });
        return Effect.sync(() => {
          state.calls.push({ tag, payload });
          if (tag === "ClaimInlineDraft") return true;
          if (tag === "Threads") return state.page;
          if (tag === "Thread") return [];
          if (tag === "Accounts") return state.accounts;
          return false;
        });
      }),
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
      state.uncertain
        ? Effect.fail(new SendUncertain({ message: "The server did not confirm" }))
        : Effect.sync(() => {
            state.delivered(...args);
          }),
    discardDraft: () => Effect.void,
    openDraft: () => Effect.succeed(null),
    draftStatus: () => Effect.succeed(null),
    openThreadWindow: () => Effect.void,
    syncNow: Effect.void,
  };
});
vi.mock("../ui/Confirm", () => ({
  confirmOpen: () => state.confirms.length > 0,
  confirmDialog: () =>
    new Promise<boolean>((resolve) => {
      state.confirms.push(resolve);
    }),
}));
vi.mock("../state/desktop", () => ({
  useDesktopEvents: (receive: (event: DesktopEvent) => void) => {
    state.emit.mockImplementation(receive);
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
  const searchRef = useRef<HTMLInputElement>(null);
  const navigation = useMailSelection({
    accountsReady: true,
    accountList: state.accounts,
    run,
  });
  const undoRef = useRef<(() => void) | null>(null);
  const [, updateToast] = useState<ToastState | null>(null);
  const setToast = (value: Parameters<typeof updateToast>[0]) => {
    state.toastUpdates(value);
    updateToast(value);
  };
  const composition = useMailCompose({
    messages,
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
    accountList: state.accounts,
    labels: [],
    run,
    say: notify,
    showUndo,
    selectedAccount: account,
  });
  const panes = usePaneNavigation({ layout: useMailLayout(), navigation, run });
  useMailShortcuts({
    searchRef,
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
    searchRef,
    navigation,
    composition,
    run,
    threadState: null,
    say: notify,
    accountList: state.accounts,
    undoRef,
    showUndo,
    sidebarShown: true,
    spaces: [],
  });
  useEffect(() => {
    searchFieldRef = searchRef;
    model = { navigation, mailActions, composition };
  });
  return null;
}
let searchFieldRef: { current: HTMLInputElement | null };
let model: {
  navigation: ReturnType<typeof useMailSelection>;
  mailActions: ReturnType<typeof useMailActions>;
  composition: ReturnType<typeof useMailCompose>;
};
let dom: ReturnType<typeof testDom>;
let registry = AtomRegistry.make();
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
    waiting: false,
    loadingMore: false,
    canLoadMore: false,
    exhausted: true,
    loadError: false,
    moreNotLoaded: null,
    searchingServer: false,
    searchTruncated: false,
    searchErrorAccounts: [],
    searchReauthAccounts: [],
    searchInputInvalid: false,
    searchIgnored: [],
  });
  state.calls = [];
  state.search = "";
  state.fail = false;
  state.page = [];
  state.deferred = false;
  state.delivered.mockClear();
  state.saveGate.mockResolvedValue();
  state.cancelGate.mockResolvedValue();
  state.cancelResult.mockReturnValue("success");
  state.deliveryFailure = false;
  state.uncertain = false;
  state.confirms = [];
  state.toastUpdates.mockClear();
  state.operations.mockClear();
  state.loadMore.mockClear();
  notify.mockClear();
  showUndo.mockClear();
  undo = null;
  showUndo.mockImplementation((_result, _ids, _text, restore) => {
    undo = restore;
  });
  registry = AtomRegistry.make();
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
  // The open conversation stays while the new results include it, and goes once they don't.
  expect(model.navigation.selectedId).toBe("one");
  state.threads.mockReturnValue({ ...state.threads(), threads: [row("three")] });
  mount();
  expect(model.navigation.selection.ids.size).toBe(0);
  // Several checked rows clear on a new query, so a hidden row is never a target.
  state.threads.mockReturnValue({ ...state.threads(), threads: [row("one"), row("three")] });
  mount();
  act(() => model.navigation.selectRow("one", { toggle: false, range: false }));
  act(() => model.navigation.selectRow("three", { toggle: true, range: false }));
  expect(model.navigation.selection.ids.size).toBe(2);
  state.search = "again";
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
  act(() => registry.set(dialogAtom, "settings"));
  key("e");
  await flush();
  expect(state.operations).not.toHaveBeenCalled();
  act(() => registry.set(dialogAtom, null));
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

const checked = () => [...model.navigation.selection.ids].toSorted();
/** A key pressed in a message frame, a separate document, as the reader forwards it. */
const frameKey = (value: string) => {
  const frame = parseHTML("<html><body><p>Body</p></body></html>").document;
  const Base = dom.window.Event;
  vi.stubGlobal(
    "KeyboardEvent",
    class extends Base {
      constructor(type: string, init: KeyboardEventInit & EventInit) {
        super(type, init);
        Object.assign(
          this,
          { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false },
          init,
        );
      }
    },
  );
  frame.addEventListener("keydown", (event: KeyboardEvent) =>
    forwardFrameKey(event, dom.window.document.body),
  );
  key(value, frame.body);
};

it("Gmail's X checks a second row after J, from the list and from the message frame", () => {
  act(() => model.navigation.select("one", "mouse"));
  key("x");
  expect(checked()).toEqual(["one"]);
  key("j");
  expect(model.navigation.selection.focus).toBe("two");
  expect(checked()).toEqual(["one"]);
  key("x");
  expect(checked()).toEqual(["one", "two"]);
  expect(state.operations).not.toHaveBeenCalled();

  act(() => model.navigation.select("one", "mouse"));
  frameKey("x");
  expect(checked()).toEqual(["one"]);
  frameKey("j");
  frameKey("x");
  expect(checked()).toEqual(["one", "two"]);

  // X twice unchecks the row; X again checks it, and J still keeps it.
  act(() => model.navigation.select("one", "mouse"));
  key("x");
  key("x");
  expect(checked()).toEqual([]);
  key("x");
  key("j");
  key("x");
  expect(checked()).toEqual(["one", "two"]);
});

it("shift-selection and opening a thread end X checking", () => {
  // A shift range keeps its rows while J moves the cursor.
  act(() => model.navigation.select("one", "mouse"));
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["one", "two"]);
  expect(model.navigation.selection.checking).toBe(false);
  key("j");
  expect(model.navigation.selection.focus).toBe("three");
  expect(checked()).toEqual(["one", "two"]);
  // A range shrunk back to one row is an open row again: J moves the selection.
  act(() => model.navigation.select("one", "mouse"));
  key("ArrowDown", dom.window, { shiftKey: true });
  key("ArrowUp", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["one"]);
  key("j");
  expect(checked()).toEqual(["two"]);
  // X after a shift range unchecks the cursor row and keeps checking with one row left.
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["three", "two"]);
  key("x");
  expect(checked()).toEqual(["two"]);
  key("k");
  expect(checked()).toEqual(["two"]);
  expect(model.navigation.selection.focus).toBe("two");
  // Shift extends from the checked rows and ends checking.
  key("x");
  key("j");
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(model.navigation.selection.checking).toBe(false);
  // Opening a thread ends checking: J then moves the open thread.
  key("x");
  expect(model.navigation.selection.checking).toBe(true);
  act(() => model.navigation.selectRow("one", { toggle: false, range: false }));
  expect(model.navigation.selection.checking).toBe(false);
  key("j");
  expect(checked()).toEqual(["two"]);
  key("x");
  act(() => model.navigation.select("three", "keyboard"));
  key("k");
  expect(checked()).toEqual(["two"]);
});

it("Shift+arrow after X and J adds the range to the checked rows", () => {
  state.threads.mockReturnValue({
    ...state.threads(),
    threads: [row("one"), row("two"), row("three"), row("four"), row("five")],
  });
  mount();
  act(() => model.navigation.select("one", "mouse"));
  key("x");
  key("j");
  key("x");
  key("j");
  expect(model.navigation.selection.focus).toBe("three");
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["four", "one", "three", "two"]);
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["five", "four", "one", "three", "two"]);
  // Shrinking the range keeps the rows X checked.
  key("ArrowUp", dom.window, { shiftKey: true });
  key("ArrowUp", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["one", "three", "two"]);
  key("ArrowUp", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["one", "three", "two"]);
  // A new plain range after opening a row starts fresh.
  act(() => model.navigation.select("four", "mouse"));
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["five", "four"]);
});

it("archiving checked rows opens the cursor row, not the next row", async () => {
  act(() => model.navigation.select("one", "mouse"));
  key("x");
  key("j");
  key("j");
  expect(model.navigation.selection.focus).toBe("three");
  key("e");
  await flush();
  expect(state.operations).toHaveBeenCalledWith(["one"], { kind: "archive" }, false);
  expect(model.navigation.selectedId).toBe("three");
  expect(model.navigation.selection.checking).toBe(false);
});

it("Escape clears checked rows after popups and the search field", () => {
  act(() => model.navigation.select("one", "mouse"));
  key("x");
  key("j");
  key("x");
  expect(checked()).toEqual(["one", "two"]);
  // A dialog and the search field take Escape first.
  act(() => registry.set(dialogAtom, "settings"));
  key("Escape");
  expect(checked()).toEqual(["one", "two"]);
  act(() => registry.set(dialogAtom, null));
  const field = dom.window.document.createElement("input");
  dom.window.document.body.append(field);
  key("Escape", field);
  expect(checked()).toEqual(["one", "two"]);
  expect(key("Escape").defaultPrevented).toBe(true);
  expect(checked()).toEqual(["two"]);
  expect(model.navigation.selection.checking).toBe(false);
  expect(model.navigation.selectedId).toBe("two");
  // A shift range clears the same way; with one open row Escape does nothing to it.
  key("ArrowDown", dom.window, { shiftKey: true });
  expect(checked()).toEqual(["three", "two"]);
  key("Escape");
  expect(checked()).toEqual(["three"]);
  expect(key("Escape").defaultPrevented).toBe(false);
  expect(checked()).toEqual(["three"]);
});

it("Escape in the search field puts focus back where it was before the field took it", () => {
  const document = dom.window.document;
  const row = document.createElement("button");
  const field = document.createElement("input");
  document.body.append(row, field);
  searchFieldRef.current = field;
  try {
    // The DOM stub does not track the focused element, so watch the call.
    const focus = vi.spyOn(row, "focus");
    rememberSearchReturn(row, null);
    key("Escape", field);
    expect(focus).toHaveBeenCalledTimes(1);
  } finally {
    searchFieldRef.current = null;
  }
});

it("native bridge defers search while a dialog is open and updates menu state", async () => {
  act(() => {
    model.navigation.select("one", "mouse");
    registry.set(dialogAtom, "settings");
  });
  await flush();
  expect(state.calls.filter((call) => call.tag === "SetNativeMenuState").at(-1)?.payload).toEqual({
    state: {
      selected: false,
      composing: false,
      important: false,
      panes: { sidebar: true, toolbar: true, reader: true },
      spaces: [],
      // An open dialog makes Close window close it before the window.
      sheet: true,
    },
  });
  act(() => state.emit({ _tag: "Search", query: "deferred" }));
  expect(model.navigation.query).toBe("");
  act(() => registry.set(dialogAtom, null));
  await flush();
  await flush();
  expect(model.navigation.query).toBe("deferred");
  expect(model.navigation.view).toEqual({ space: ALL, mailbox: "all" });
});

it("panels keep independent state and layout persistence follows overview and sidebar preferences", () => {
  act(() => {
    registry.set(goToFolderAtom, true);
    registry.set(pickerModeAtom, "move");
  });
  expect(registry.get(goToFolderAtom)).toBe(true);
  expect(registry.get(pickerModeAtom)).toBe("move");
  expect(registry.get(dialogAtom)).toBeNull();
  const panels: ReturnType<typeof usePanelLayout>[] = [];
  function LayoutHarness() {
    const layout = usePanelLayout({
      prefs: { ...DEFAULT_PREFS, sidebarVisible: false },
      hasAccounts: true,
      view: { space: OVERVIEW, mailbox: "inbox" },
      mode: "wide",
    });
    useEffect(() => {
      panels.push(layout);
    });
    return null;
  }
  dom.render(createElement(LayoutHarness));
  expect(panels.at(-1)).toMatchObject({ docked: false, paneMode: "overview" });
  expect(panels.at(-1)?.sizesKey).toContain("overview");
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

// An older page in flight made canLoadMore false, so removing the last loaded row moved the
// selection up instead of waiting for the row after it.
it("removing the last loaded row while an older page loads waits for that page", async () => {
  state.threads.mockReturnValue({
    ...state.threads(),
    canLoadMore: false,
    loadingMore: true,
    waiting: true,
  });
  mount();
  state.page = [row("four")];
  act(() => model.navigation.select("three", "keyboard"));
  act(() => model.mailActions.act({ kind: "archive" }));
  await flush();
  await flush();
  expect(model.navigation.selectedId).toBe("three");
  state.threads.mockReturnValue({
    ...state.threads(),
    threads: [row("one"), row("two"), row("four")],
    loadingMore: false,
    waiting: false,
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
    expect(state.calls.some((call) => call.tag === "QueueUndoSend")).toBe(true);
    expect(state.calls.some((call) => call.tag === "CancelWaitingSend")).toBe(true);
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

it("undo then resend retains the new pending send after the old window expires", async () => {
  vi.useFakeTimers();
  try {
    state.prefs.mockReturnValue({ ...state.prefs(), undoSendSeconds: 5 });
    mount();
    const draft = { ...emptyDraft(account.id), to: "alice@example.com", subject: "Resent draft" };
    const message = toDraftInput(draft).message;
    act(() => model.composition.send(draft, message, { archive: false }));
    await flush();
    act(() => model.composition.undoSend());
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    act(() => model.composition.send(draft, message, { archive: false }));
    await flush();
    await act(() => vi.advanceTimersByTimeAsync(4000));
    await flush();
    expect(state.delivered).not.toHaveBeenCalled();
    expect(model.composition.hasPendingSends()).toBe(true);
    expect(state.calls.filter((call) => call.tag === "SetSendState").at(-1)?.payload).toEqual({
      pending: 1,
      undoAvailable: true,
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await flush();
    expect(state.delivered).toHaveBeenCalledOnce();
    expect(model.composition.hasPendingSends()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

for (const cancellation of ["false", "failure"] as const) {
  for (const deliveryFailure of [false, true]) {
    it(`a ${cancellation} undo preserves the real ${deliveryFailure ? "failed" : "sent"} outcome`, async () => {
      vi.useFakeTimers();
      try {
        state.prefs.mockReturnValue({ ...state.prefs(), undoSendSeconds: 5 });
        state.cancelResult.mockReturnValue(cancellation);
        state.deliveryFailure = deliveryFailure;
        let finishCancel: () => void = () => {
          throw new Error("Cancel was not started");
        };
        state.cancelGate.mockReturnValue(
          new Promise<void>((resolve) => {
            finishCancel = resolve;
          }),
        );
        mount();
        const draft = { ...emptyDraft(account.id), to: "alice@example.com" };
        const message = toDraftInput(draft).message;
        act(() => model.composition.send(draft, message, { archive: false }));
        await flush();
        act(() => model.composition.undoSend());
        await act(() => vi.advanceTimersByTimeAsync(5000));
        expect(notify).not.toHaveBeenCalledWith({ text: messages.sent });
        finishCancel();
        await flush();
        await flush();
        if (deliveryFailure) {
          expect(notify.mock.lastCall?.[0]).toEqual({
            text: messages.couldntSend("Can't reach the mail server right now."),
            tone: "error",
          });
          expect(model.composition.compose).toEqual(draft);
          state.deliveryFailure = false;
          act(() => model.composition.send(draft, message, { archive: false }));
          await act(() => vi.advanceTimersByTimeAsync(5000));
          expect(state.confirms).toHaveLength(0);
        } else {
          expect(notify.mock.lastCall?.[0]).toEqual({ text: messages.sent });
          expect(model.composition.compose).toBeNull();
        }
        expect(model.composition.hasPendingSends()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  }
}

it("a second Send while the resend confirmation is open neither queues another nor sends twice", async () => {
  state.prefs.mockReturnValue({ ...state.prefs(), undoSendSeconds: 0 });
  state.uncertain = true;
  mount();
  const draft = { ...emptyDraft(account.id), to: "alice@example.com" };
  const message = toDraftInput(draft).message;
  act(() => model.composition.send(draft, message, { archive: false }));
  await flush();
  expect(state.delivered).not.toHaveBeenCalled();
  state.uncertain = false;
  act(() => model.composition.send(draft, message, { archive: false }));
  act(() => model.composition.send(draft, message, { archive: false }));
  expect(state.confirms).toHaveLength(1);
  act(() => state.confirms.shift()?.(true));
  await flush();
  await flush();
  expect(state.delivered).toHaveBeenCalledOnce();
});

it("a refused undo clears its toast and undo action while keeping the active send pending", async () => {
  vi.useFakeTimers();
  try {
    state.prefs.mockReturnValue({ ...state.prefs(), undoSendSeconds: 5 });
    state.cancelResult.mockReturnValue("false");
    mount();
    const draft = { ...emptyDraft(account.id), to: "alice@example.com" };
    act(() => model.composition.send(draft, toDraftInput(draft).message, { archive: false }));
    await flush();
    act(() => model.composition.undoSend());
    await flush();
    expect(state.toastUpdates).toHaveBeenCalledWith(null);
    expect(model.composition.hasPendingSends()).toBe(true);
    expect(state.calls.filter((call) => call.tag === "SetSendState").at(-1)?.payload).toEqual({
      pending: 1,
      undoAvailable: false,
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(state.delivered).toHaveBeenCalledOnce();
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
    "../ui/Confirm",
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
    registry.set(snoozeIdsAtom, ["0"]);
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
  expect(registry.get(snoozeIdsAtom)).toBeNull();
  await flush();
  expect(model.navigation.selectedId).toBe("1");
});

const messages = {
  cantOpenTheMessage: (reason: string) => `Can't open the message: ${reason}`,
  opDone: (op: MailOp) =>
    op.kind === "label" ? (op.value ? "Label added" : "Label removed") : "Done",
  couldNotLoadTheNextMessage: `Couldn't load the next message`,
  actionFailed: (reason: string) => `Action failed: ${reason}`,
  noCurrentLabelAppliesMovingToTrash: `No current label applies. Moving to Trash.`,
  finishSigningInInYourBrowser: `Finish signing in in your browser`,
  isSignedInAgain: (email: string) => `${email} is signed in again`,
  signInFailed: (reason: string) => `Sign-in failed: ${reason}`,
  snoozed: `Snoozed`,
  permanentlyDeletedMessages: (count: number) => `Permanently deleted ${count} messages`,
  couldntDelete: (reason: string) => `Couldn't delete: ${reason}`,
  cantOpenTheDraft: (reason: string) => `Can't open the draft: ${reason}`,
  couldNotOpenTheComposeWindow: `Couldn't open the compose window`,
  connectAnAccountToSendFeedback: `Connect an account to send feedback`,
  couldNotOpenTheFeedbackDraft: `Couldn't open the feedback draft`,
  couldNotOpenTheDraft: `Couldn't open the draft`,
  couldntSaveTheDraft: (reason: string) => `Couldn't save the draft: ${reason}`,
  draftDiscarded: `Draft discarded`,
  couldntDiscard: (reason: string) => `Couldn't discard: ${reason}`,
  sentAndArchived: `Sent and archived`,
  sent: `Sent`,
  couldntSend: (reason: string) => `Couldn't send: ${reason}`,
  couldntSendSubject: (subject: string, reason: string) => `Couldn't send ${subject}: ${reason}`,
  openDraft: `Open draft`,
  couldntRestoreTheDraft: (reason: string) => `Couldn't restore the draft: ${reason}`,
  sending: `Sending…`,
  undo: `Undo`,
  gmailSize: `Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
  gmailBlocked: (filename: string) =>
    `Gmail blocks ${filename}. Remove this attachment before sending.`,
  outlookSize: `Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
  outlookItemSize: `Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
} satisfies AppMessages;
