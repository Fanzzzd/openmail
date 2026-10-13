import type { ComposeMessages } from "./use-compose-messages";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import {
  DEFAULT_PREFS,
  richComposeBody,
  textComposeHtml,
  type Account,
  type Prefs,
  type SendAs,
  type Signature,
} from "@openmail/core/schema";
import type { Effect } from "effect";
import { act, createElement, useEffect, useRef, useState } from "react";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyDraft, isEmpty, type Draft } from "../draft";
import { useRunMail } from "../../../state/mail";
import { testDom } from "../../../test-support/test-dom";
import { useComposeDraft } from "./use-compose-draft";
import { useComposeEditor } from "./use-compose-editor";
import { useComposeRecipients } from "./use-compose-recipients";
import { useComposeSend } from "./use-compose-send";
import { useComposeShortcuts } from "./use-compose-shortcuts";
import { useDraftLifecycle } from "./use-draft-lifecycle";

const state = vi.hoisted(() => {
  vi.resetModules();
  return {
    prefs: vi.fn<() => Prefs>(),
    aliases: new Array<SendAs>(),
    signatures: new Array<Signature>(),
    save: vi.fn(),
    calls: new Array<{ tag: string; payload: unknown }>(),
    fail: false,
  };
});
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return {
    useAtom: () => [AsyncResult.initial(), state.save],
    useAtomValue: (atom: string) =>
      atom === "prefs"
        ? AsyncResult.success(state.prefs())
        : atom === "aliases"
          ? AsyncResult.success(state.aliases)
          : atom === "signatures"
            ? AsyncResult.success(state.signatures)
            : atom === "status"
              ? AsyncResult.initial()
              : AsyncResult.success([]),
  };
});
vi.mock("../../../state/queries", () => ({
  prefsAtom: "prefs",
  signaturesAtom: "signatures",
  namedSignaturesAtom: "library",
  sendAsAtom: "aliases",
  draftStatusAtom: () => "status",
}));
vi.mock("../../../state/mutations", () => ({ saveDraftAtom: () => "save" }));
vi.mock("../../../state/mail", async () => {
  const { Effect } = await import("effect");
  const { InvalidInput, NotFound } = await import("@openmail/core/schema");
  return {
    useRunMail: () => Effect.runFork,
    openDraft: () => Effect.fail(new NotFound({ what: "draft", id: "missing" })),
    draftStatus: () => Effect.succeed(null),
    withMail: (
      f: (
        call: (tag: string, payload: unknown) => Effect.Effect<unknown, unknown>,
      ) => Effect.Effect<unknown, unknown>,
    ) =>
      f((tag, payload) => {
        state.calls.push({ tag, payload });
        return state.fail
          ? Effect.fail(new InvalidInput({ message: "failure" }))
          : Effect.succeed(null);
      }),
  };
});
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
const other: Account = { ...account, id: "b", email: "other@example.com" };
const sent = vi.fn();
const closed = vi.fn();
const popped = vi.fn();
let initial: Draft;
let popOutRequested = 0;
let closeRequested = 0;
function Harness() {
  const run = useRunMail();
  const { draft, setDraft, prefs } = useComposeDraft(initial);
  const [adding, setAdding] = useState(false);
  const ccRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    sendFlow.setAsking(null);
  };
  const recipients = useComposeRecipients({
    initial,
    accounts: [account, other],
    draft,
    prefs,
    setDraft,
    set,
    run,
  });
  const sendFlow = useComposeSend({
    messages,
    draft,
    prefs,
    account: recipients.account,
    adding,
    currentSignature: recipients.currentSignature,
    onSend: sent,
  });
  const editor = useComposeEditor({
    messages,
    initial,
    prefs,
    setDraft,
    adding,
    draft,
    account: recipients.account,
    showAttachmentProblem: sendFlow.showAttachmentProblem,
    setError: sendFlow.setError,
    setAdding,
    original: undefined,
    set,
    run,
    aliases: recipients.aliases,
    currentAddress: recipients.currentAddress,
    setShowBcc: recipients.setShowBcc,
  });
  const lifecycle = useDraftLifecycle({
    messages,
    initial,
    draft,
    run,
    adding,
    empty: isEmpty(draft, recipients.currentSignature?.text, prefs),
    setDraft,
    setAdding,
    setError: sendFlow.setError,
    onClose: closed,
    onPopOut: popped,
    popOutRequested,
    closeRequested,
  });
  useComposeShortcuts({ draft, prefs, recipients, sendFlow, editor, lifecycle, ccRef });
  useEffect(() => {
    model = { draft, setDraft, setAdding, recipients, sendFlow, editor, lifecycle };
  }, [draft, setDraft, setAdding, recipients, sendFlow, editor, lifecycle]);
  return null;
}
let model: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  setAdding: React.Dispatch<React.SetStateAction<boolean>>;
  recipients: ReturnType<typeof useComposeRecipients>;
  sendFlow: ReturnType<typeof useComposeSend>;
  editor: ReturnType<typeof useComposeEditor>;
  lifecycle: ReturnType<typeof useDraftLifecycle>;
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
beforeEach(() => {
  state.prefs.mockReturnValue(DEFAULT_PREFS);
  state.aliases = [];
  state.signatures = [];
  state.calls = [];
  state.fail = false;
  state.save.mockClear();
  sent.mockClear();
  closed.mockClear();
  popped.mockClear();
  initial = emptyDraft(account.id);
  popOutRequested = 0;
  closeRequested = 0;
  dom = testDom();
  vi.stubGlobal("HTMLDivElement", dom.window.HTMLDivElement);
  vi.stubGlobal("HTMLTextAreaElement", dom.window.HTMLTextAreaElement);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});
afterEach(() => {
  dom.dispose();
  vi.useRealTimers();
});

it("fresh drafts adopt the compose font, while reopened drafts retain their body", () => {
  mount();
  expect(model.draft.body.kind === "rich" && model.draft.body.font).toEqual(
    DEFAULT_PREFS.composeFont,
  );
  dom.render(null);
  initial = { ...emptyDraft(account.id), synced: false };
  mount();
  expect(model.draft).toBe(initial);
});

it("draft lifecycle debounces edits, pauses autosave during attachments and recovers the current draft", async () => {
  vi.useFakeTimers();
  initial = { ...initial, synced: false, subject: "Existing" };
  mount();
  act(() => model.setDraft((draft) => ({ ...draft, subject: "First edit" })));
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(state.save).not.toHaveBeenCalled();
  act(() => model.setDraft((draft) => ({ ...draft, subject: "Second edit" })));
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(state.save).not.toHaveBeenCalled();
  act(() => model.setAdding(true));
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(state.save).not.toHaveBeenCalled();
  act(() => model.setAdding(false));
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(state.save).toHaveBeenCalledTimes(1);
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.objectContaining({ subject: "Second edit" }) }),
  );
  act(() => model.lifecycle.recover("retry"));
  await flush();
  expect(state.calls.filter((call) => call.tag === "RecoverDraft")).toEqual([
    {
      tag: "RecoverDraft",
      payload: expect.objectContaining({
        action: "retry",
        draft: expect.objectContaining({
          message: expect.objectContaining({ subject: "Second edit" }),
        }),
      }),
    },
  ]);
  expect(model.lifecycle.recovering).toBe(false);
  state.fail = true;
  act(() => model.lifecycle.recover("local"));
  await flush();
  expect(model.lifecycle.recoveryError).not.toBe("");
});

it("native close and pop-out use the latest edits and unmount cancels autosave", async () => {
  vi.useFakeTimers();
  mount();
  act(() => model.setDraft((draft) => ({ ...draft, subject: "Latest" })));
  popOutRequested = 1;
  mount();
  await flush();
  expect(popped).toHaveBeenCalledWith(model.draft);
  closeRequested = 1;
  mount();
  await flush();
  expect(model.lifecycle.closing).toBe(true);
  expect(closed).not.toHaveBeenCalled();
  dom.render(null);
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(state.save).not.toHaveBeenCalled();
});

it("recipient moves and mentions preserve manual recipients, and sender changes replace signatures", () => {
  initial = {
    ...initial,
    to: "manual@example.com",
    organization: { labels: ["x"], starred: false },
  };
  state.signatures = [
    { address: account.email, kind: "new", text: "First" },
    { address: other.email, kind: "new", text: "Second" },
  ];
  mount();
  act(() => {
    model.recipients.addMention({ name: "Alice", address: "alice@example.com" });
    model.recipients.removeMentions(["alice@example.com"]);
  });
  expect(model.draft.to).toContain("alice@example.com");
  act(() => model.recipients.removeMentions([]));
  expect(model.draft.to).toBe("manual@example.com");
  act(() => model.recipients.moveChip("to", "cc", 0));
  expect(model.draft.to).toBe("");
  expect(model.draft.cc).toContain("manual@example.com");
  expect(model.recipients.showBcc).toBe(true);
  act(() => model.recipients.selectSender(`${other.id}/${other.email}`));
  expect(model.draft.accountId).toBe(other.id);
  expect(model.draft.organization).toBeUndefined();
  expect(model.draft.body.text).toContain("Second");
  act(() => model.recipients.chooseSignature("none"));
  expect(model.draft.body.text).not.toContain("Second");
});

it("send flow validates recipients, confirms subject and attachments, and retains send-and-archive intent", () => {
  initial = {
    ...initial,
    mode: "reply",
    inReplyTo: "source",
    body: richComposeBody(textComposeHtml("Please see the attachment.")),
  };
  mount();
  act(() => model.sendFlow.submit(true));
  expect(model.sendFlow.error).toBe("Add at least one recipient");
  act(() => model.recipients.changeRecipients("to", "bad address"));
  act(() => model.sendFlow.submit(true));
  expect(model.sendFlow.error).toContain("These are not email addresses");
  act(() => model.recipients.changeRecipients("to", "alice@example.com"));
  act(() => model.sendFlow.submit(true));
  expect(model.sendFlow.asking?.warning).toBe("subject");
  act(() => model.sendFlow.submit(true, ["subject"]));
  expect(model.sendFlow.asking?.warning).toBe("attachment");
  act(() => model.sendFlow.submit(true, ["subject", "attachment"]));
  expect(sent).toHaveBeenCalledWith(
    model.draft,
    expect.objectContaining({ to: [{ name: "", address: "alice@example.com" }] }),
    { archive: true },
  );
  expect(model.sendFlow.asking).toBeNull();
});

it("editor integration inserts templates into the active body and merges recipients without duplicates", () => {
  initial = {
    ...initial,
    to: "Alice <alice@example.com>",
    body: { kind: "plain", text: "Existing " },
  };
  mount();
  const textarea = dom.window.document.createElement("textarea");
  textarea.value = "Existing ";
  textarea.setRangeText = (
    text: string,
    start: number = textarea.selectionStart,
    end: number = textarea.selectionEnd,
  ) => {
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  };
  textarea.setSelectionRange = vi.fn();
  Object.assign(textarea, { selectionStart: 9, selectionEnd: 9 });
  model.editor.bodyRef.current = textarea;
  act(() =>
    model.editor.insertTemplate({
      id: "t",
      updatedAt: 0,
      name: "Greeting",
      subject: "Hello",
      to: [{ name: "Alice", address: "ALICE@example.com" }],
      cc: [{ name: "Bob", address: "bob@example.com" }],
      body: "Template body",
    }),
  );
  expect(model.draft.to).toBe("Alice <alice@example.com>");
  expect(model.draft.cc).toBe("Bob <bob@example.com>");
  expect(model.draft.subject).toBe("Hello");
  expect(model.draft.body.text).toContain("Template body");
  expect(model.recipients.showBcc).toBe(true);
  act(() =>
    model.editor.appendAttachments(
      [{ filename: "file.txt", mimeType: "text/plain", content: "aGk=" }],
      false,
    ),
  );
  expect(model.draft.attachments).toHaveLength(1);
});

it("compose shortcuts save the current draft and yield to send confirmation", () => {
  mount();
  const shortcut = (key: string, shiftKey = false) => {
    const event = new dom.window.Event("keydown", { cancelable: true });
    Object.assign(event, { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey });
    void act(() => dom.window.dispatchEvent(event));
    return event;
  };
  act(() => model.setDraft((draft) => ({ ...draft, to: "alice@example.com" })));
  expect(shortcut("s").defaultPrevented).toBe(true);
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.objectContaining({ to: [{ name: "", address: "alice@example.com" }] }),
    }),
  );
  act(() => model.sendFlow.submit(false));
  const calls = state.save.mock.calls.length;
  shortcut("s");
  expect(state.save).toHaveBeenCalledTimes(calls);
});

afterAll(() => {
  for (const name of [
    "@effect/atom-react",
    "../../../state/queries",
    "../../../state/mutations",
    "../../../state/mail",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});

const messages = {
  couldntLoadTheOriginalAttachments: (reason: string) =>
    `Couldn't load the original attachments: ${reason}`,
  saving: `Saving…`,
  couldntSave: `Couldn't save`,
  keptOnThisMac: `Kept on this Mac`,
  couldntSync: `Couldn't sync`,
  savedOnThisMacRetryingSyncAutomatically: `Saved on this Mac. Retrying sync automatically.`,
  saved: `Saved`,
  savedOnThisMacSyncsWhenOnline: `Saved on this Mac. Syncs when online.`,
  waitForAttachmentsToFinishLoading: `Wait for attachments to finish loading.`,
  listSeparator: ", ",
  theseAreNotEmailAddresses: (list: string) => `These are not email addresses: ${list}`,
  addAtLeastOneRecipient: `Add at least one recipient`,
  attachmentsExceedThe30MBComposeLimit: `Attachments exceed the 30 MB compose limit.`,
  couldntReadTheAttachmentTryAddingIt: `Couldn't read the attachment. Try adding it again.`,
  couldntLoadTheOriginalAttachmentsTryAgain: `Couldn't load the original attachments. Try again.`,
  chooseBeforeInsertingAnImage: (editBody: string) =>
    `Choose ${editBody} before inserting an image.`,
  couldntInsertTheImageUseAPublic: `Couldn't insert the image. Use a public PNG, JPEG, GIF or WebP image up to 8 MB.`,
  useAnImageUpTo8MB: `Use an image up to 8 MB.`,
  usePNGJPEGGIFOrWebPImages: `Use PNG, JPEG, GIF or WebP images up to 8 MB.`,
  couldntReadTheImage: `Couldn't read the image.`,
  chooseBeforeInsertingATemplate: (editBody: string) =>
    `Choose ${editBody} before inserting a template.`,
  couldntReadTheClipboardAttachment: `Couldn't read the clipboard attachment.`,
  gmailSize: `Gmail attachments exceed 25 MB in total. Remove attachments before sending.`,
  gmailBlocked: (filename: string) =>
    `Gmail blocks ${filename}. Remove this attachment before sending.`,
  outlookSize: `Outlook.com messages are limited to 25 MB, including message text and attachments. Remove attachments before sending.`,
  outlookItemSize: `Outlook cannot upload attached messages of 3 MB or more. Remove this attachment before sending.`,
} satisfies ComposeMessages;
