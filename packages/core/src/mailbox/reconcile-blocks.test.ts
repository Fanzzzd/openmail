import { TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";
import { ProviderError } from "../domain/errors.js";

it.effect(
  "a reconcile whose fetch keeps failing does not block later user ops on that message",
  () => {
    const pushed: string[] = [];
    return Effect.gen(function* () {
      const store = yield* Store;
      const mailbox = yield* Mailbox;
      const account = yield* store.upsertAccount("gmail", "me@example.com");
      yield* store.enqueueOp(account.id, "m1", { kind: "reconcile" });
      yield* store.enqueueOp(account.id, "m1", { kind: "archive" });
      yield* mailbox.sync.sync();
      assert.include(pushed, "archive", "the archive does not wait for the failing refresh");
      const left = (yield* store.listPendingOps).map((p) => p.op.kind);
      assert.deepStrictEqual(left, ["reconcile"], "the refresh keeps retrying");
    }).pipe(
      Effect.provide(
        TestMailbox.withAdapter(
          (base) => ({
            ...base,
            fetchMessage: () =>
              Effect.fail(new ProviderError({ message: "Backend Error", status: 500 })),
            push: (acc, id, op, ...rest) => {
              pushed.push(op.kind);
              return base.push(acc, id, op, ...rest);
            },
          }),
          { options: { backgroundFlush: false } },
        ),
      ),
    );
  },
);
