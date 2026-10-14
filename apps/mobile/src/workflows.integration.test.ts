import { expect, it } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Mailbox } from "@openmail/core/portable";
import { TestMailbox, fakeServer } from "@openmail/core/testing/node";
import { message } from "../../../packages/core/test-support/semantic-fixtures";
import { composeMessage, searchQuery } from "./workflows";
for (const provider of ["gmail", "outlook"] as const) {
  it(`${provider}: mobile view models enter the shared Mailbox command and search paths`, async () => {
    const server = fakeServer("me@example.test", [
      message({
        subject: "Mobile",
        from: { name: "Alice", address: "alice@example.test" },
        to: [],
        date: Date.now(),
        snippet: "budget",
        bodyText: "budget",
        labels: ["INBOX", "UNREAD"],
      }),
    ]);
    const runtime = ManagedRuntime.make(
      TestMailbox(
        { [provider]: server },
        { backgroundFlush: false, imapIdle: false, localDraftQueue: true },
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider });
          yield* mailbox.sync(account.id);
          const row = (yield* mailbox.threads(
            searchQuery(account.id, "from:alice@example.test is:unread budget"),
          ))[0];
          if (!row) throw new Error("missing message");
          const result = yield* mailbox.modifyWithUndo([row.id], { kind: "read", value: true });
          expect((yield* mailbox.threads({ accountIds: [account.id] }))[0]?.isUnread).toBe(false);
          yield* mailbox.undoBatch(result.undoId);
          const moved = yield* mailbox.modifyWithUndo(
            [row.id],
            provider === "gmail"
              ? { kind: "label", labelId: "Label_project", value: true }
              : { kind: "move", labelId: "ARCHIVE", removeLabelId: "INBOX" },
          );
          yield* mailbox.undoBatch(moved.undoId);
          const draft = {
            id: `draft:${provider}`,
            accountId: account.id,
            message: {
              ...composeMessage("new"),
              to: [{ name: "", address: "alice@example.test" }],
              subject: "Mobile",
              text: "queued offline",
            },
          };
          yield* mailbox.saveDraft(draft);
          expect(server.draftLog).toEqual([]);
          yield* mailbox.outbox.queueSend(draft, Date.now() + 60000);
          expect(server.sent).toEqual([]);
          expect(yield* mailbox.outbox.cancelWaitingSend(draft.id)).toBe(true);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
}
