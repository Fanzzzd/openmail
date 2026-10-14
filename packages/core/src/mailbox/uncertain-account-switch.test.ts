import { TestMailbox } from "../platform/node/testing.js";
import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";
import { SendUncertain } from "../domain/errors.js";

const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Test",
  text: "Hello",
  attachments: [],
};
const user = { kind: "user", surface: "app" } as const;

it.effect("changing the From account of an uncertain-send draft keeps the resend guard", () => {
  let submissions = 0;
  return Effect.gen(function* () {
    const mailbox = yield* Mailbox;
    const store = yield* Store;
    const gmail = yield* mailbox.accounts.connect({ provider: "gmail" });
    const outlook = yield* mailbox.accounts.connect({ provider: "outlook" });
    yield* mailbox.compose.saveDraft({ id: "draft:x", accountId: gmail.id, message: outgoing });
    assert.ok(Option.getOrThrow(yield* store.getDraft("draft:x")).remote, "draft pushed");
    const send = {
      kind: "send",
      accountId: gmail.id,
      draftId: "draft:x",
      message: outgoing,
    } as const;
    assert.strictEqual(
      (yield* mailbox.organize.perform(send, user).pipe(Effect.flip))._tag,
      "SendUncertain",
    );
    assert.isTrue(yield* store.sendUncertain("draft:x"));
    // The person switches the From account in the composer; autosave runs.
    yield* mailbox.compose.saveDraft({ id: "draft:x", accountId: outlook.id, message: outgoing });
    assert.isTrue(
      yield* store.sendUncertain("draft:x"),
      "resend guard must survive an account switch",
    );
    // Sending again from the new account needs the person to confirm the resend.
    const again = yield* mailbox.organize
      .perform({ ...send, accountId: outlook.id }, user)
      .pipe(Effect.result);
    assert.strictEqual(again._tag, "Failure");
    assert.strictEqual(submissions, 1);
  }).pipe(
    Effect.provide(
      TestMailbox.withAdapter(
        (base) => ({
          ...base,
          send: (...args) =>
            ++submissions === 1
              ? Effect.fail(new SendUncertain({ message: "Unknown submission" }))
              : base.send(...args),
        }),
        { options: { backgroundFlush: false, imapIdle: false } },
      ),
    ),
  );
});
