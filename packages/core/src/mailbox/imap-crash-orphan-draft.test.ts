import { TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";
import type { DraftRemote } from "../domain/changes.js";

const message = { to: [], cc: [], bcc: [], subject: "s", text: "t", attachments: [] };

for (const crashed of [false, true])
  it.effect(
    `IMAP draft APPEND then discard (claim ${crashed ? "left by a crash" : "released"})`,
    () => {
      const deletes: DraftRemote[] = [];
      return Effect.gen(function* () {
        const store = yield* Store;
        const mailbox = yield* Mailbox;
        const account = yield* store.upsertAccount("imap", "me@example.com");
        yield* store.putDraft({ id: "d", accountId: account.id, message });
        yield* store.enqueueDraftSave(account.id, "d");
        const [op] = yield* store.listPendingOps;
        assert.ok(op);
        // A push claimed the op, recorded the APPEND identity (beforeAppendDraft), and APPENDed.
        assert.isTrue(yield* store.claimPendingOp(op.id, "worker"));
        yield* store.recordAppendedMessageId(op.id, "worker", "<orphan@example.com>");
        // Either the push failed and released its claim, or the process died here.
        if (!crashed) yield* store.failPendingOp(op.id, "offline", "worker", true);
        // After restart, the person discards the draft before the stale claim expires.
        yield* mailbox.compose.discardDraft("d");
        yield* TestClock.adjust("2 hours");
        yield* mailbox.sync.sync();
        assert.isTrue(
          deletes.some((r) => r.rfcMessageId === "<orphan@example.com>"),
          "the APPENDed server copy is deleted",
        );
      }).pipe(
        Effect.provide(
          TestMailbox.withAdapter(
            (base) => ({
              ...base,
              deleteDraft: (acc, remote) => {
                deletes.push(remote);
                return base.deleteDraft(acc, remote);
              },
            }),
            { options: { backgroundFlush: false } },
          ),
        ),
      );
    },
  );
