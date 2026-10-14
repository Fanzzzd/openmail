import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  fakeServer,
  TestMailbox,
} from "../../../../../../../packages/core/src/platform/node/testing.js";
import { Mailbox } from "../../../../../../../packages/core/src/mailbox/mailbox.js";
import { requestDraftClose } from "./draft-close";
import { emptyDraft, fromStored, isEmpty, toDraftInput } from "./draft";

it("closing a blank never-stored draft does not save or delete anything", async () => {
  const server = fakeServer("me@example.com");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        const initial = emptyDraft(account.id);
        const action = yield* requestDraftClose({
          draft: initial,
          initial,
          empty: true,
          lookup: mailbox.compose.draftStatus(initial.id),
        });
        expect(action).toBe("close");
        expect(server.draftLog).toEqual([]);
        expect(server.drafts.size).toBe(0);
      }),
    ).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
});

it("clearing a stored draft asks; Cancel and Save retain it, and only explicit Delete removes the provider copy", async () => {
  const server = fakeServer("me@example.com");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        const draft = {
          ...emptyDraft(account.id),
          to: "bob@example.com",
          subject: "Keep me",
          body: { kind: "plain" as const, text: "Content" },
        };
        const initial = fromStored(yield* mailbox.compose.saveDraft(toDraftInput(draft)));
        // The same editor cleared every field.
        const cleared = { ...emptyDraft(account.id), id: draft.id, editor: draft.editor };
        const action = yield* requestDraftClose({
          draft: cleared,
          initial,
          empty: isEmpty(cleared),
          lookup: mailbox.compose.draftStatus(draft.id),
        });
        expect(action).toBe("prompt");
        // Cancel makes no mutation and leaves the stored content available.
        expect(server.drafts.size).toBe(1);
        expect((yield* mailbox.compose.openDraft(draft.id)).message.subject).toBe("Keep me");
        expect(server.draftLog.filter((entry) => entry.kind === "delete")).toEqual([]);
        yield* mailbox.compose.saveDraft(toDraftInput(cleared));
        expect(server.drafts.size).toBe(1);
        expect((yield* mailbox.compose.openDraft(draft.id)).message.subject).toBe("");
        expect(server.draftLog.filter((entry) => entry.kind === "delete")).toEqual([]);
        yield* mailbox.compose.discardDraft(draft.id);
        expect(server.drafts.size).toBe(0);
        expect(server.draftLog.filter((entry) => entry.kind === "delete")).toHaveLength(1);
      }),
    ).pipe(Effect.provide(TestMailbox({ gmail: server }))),
  );
});
