import type { ComposeMessages } from "./use-compose-messages";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { Cause } from "effect";
import { act, createElement, useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyDraft, fromStored, toDraftInput, type Draft } from "../draft";
import { useRunMail } from "../../../state/mail";
import { testDom } from "../../../test-support/test-dom";
import { useComposeDraft } from "./use-compose-draft";
import { useDraftLifecycle } from "./use-draft-lifecycle";

const state = vi.hoisted(() => ({
  save: vi.fn(),
  /** The autosave result the mocked atom reports. */
  result: null as unknown,
  newer: null as unknown,
}));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  const { DEFAULT_PREFS } = await import("@openmail/core/schema");
  return {
    useAtom: () => [state.result ?? AsyncResult.initial(), state.save],
    useAtomValue: (atom: string) =>
      atom === "prefs" ? AsyncResult.success(DEFAULT_PREFS) : AsyncResult.initial(),
  };
});
vi.mock("../../../state/queries", () => ({
  prefsAtom: "prefs",
  draftStatusAtom: () => "status",
}));
vi.mock("../../../state/mutations", () => ({ saveDraftAtom: () => "save" }));
vi.mock("../../../state/mail", async () => {
  const { Effect } = await import("effect");
  return {
    useRunMail: () => Effect.runFork,
    openDraft: () => Effect.succeed(state.newer),
    draftStatus: () => Effect.succeed(null),
    saveDraft: () => Effect.void,
    withMail: () => Effect.succeed(null),
  };
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

let initial: Draft;
let model: {
  draft: Draft;
  setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  lifecycle: ReturnType<typeof useDraftLifecycle>;
};
function Harness() {
  const run = useRunMail();
  const { draft, setDraft } = useComposeDraft(initial);
  const [adding, setAdding] = useState(false);
  const handedOff = useRef<Draft | null>(null);
  const [, setError] = useState<string | null>(null);
  const lifecycle = useDraftLifecycle({
    messages,
    initial,
    draft,
    run,
    adding,
    empty: false,
    setDraft,
    setAdding,
    setError,
    onClose: vi.fn(),
    onPopOut: undefined,
    popOutRequested: 0,
    closeRequested: 0,
    handedOff,
  });
  useEffect(() => {
    model = { draft, setDraft, lifecycle };
  }, [draft, setDraft, lifecycle]);
  return null;
}

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
    await Promise.resolve();
  });

beforeEach(() => {
  state.save.mockClear();
  state.result = null;
  dom = testDom();
  vi.stubGlobal("HTMLDivElement", dom.window.HTMLDivElement);
});
afterEach(() => dom.dispose());

const stored = (text: string, revision: number) => ({
  id: "draft:1",
  accountId: "a",
  message: { to: [], cc: [], bcc: [], subject: "Plan", text, attachments: [] },
  updatedAt: 0,
  proposalId: null,
  synced: true,
  revision,
});

it("saves carry the editor and the revision it loaded", () => {
  const draft = { ...fromStored(stored("v1", 4)) };
  expect(toDraftInput(draft)).toMatchObject({ expectedRevision: 4, editor: draft.editor });
  const fresh = emptyDraft("a");
  expect(toDraftInput(fresh)).toMatchObject({ expectedRevision: 0, editor: fresh.editor });
});

it("a refused save shows the newer draft and keeps the person's text restorable", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  const { DraftConflict } = await import("@openmail/core/schema");
  initial = fromStored(stored("v1", 4));
  mount();
  const mine = { ...model.draft, subject: "Plan", body: { kind: "plain" as const, text: "v1." } };
  // The person typed; another editor saved revision 5 meanwhile.
  act(() => model.setDraft(mine));
  state.newer = stored("v1 + text typed on the phone", 5);
  state.result = AsyncResult.failure(Cause.fail(new DraftConflict({ id: "draft:1", revision: 5 })));
  mount();
  await flush();
  expect(model.draft.body.text).toBe("v1 + text typed on the phone");
  expect(model.draft.revision).toBe(5);
  expect(model.lifecycle.conflict?.body.text).toBe("v1.");
  expect(model.lifecycle.status).not.toBe(messages.couldntSave);
  act(() => model.lifecycle.restoreMine());
  await flush();
  expect(model.draft.body.text).toBe("v1.");
  // The restored text saves on top of revision 5 on purpose.
  expect(toDraftInput(model.draft).expectedRevision).toBe(5);
  expect(model.lifecycle.conflict).toBeNull();
});
