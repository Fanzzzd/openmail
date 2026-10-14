import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { fakeServer, outgoing, TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";

const GMAIL = "gmail:me@gmail.com";

it.effect("two editors of one draft: a save from the older revision is refused", () => {
  const gmail = fakeServer("me@gmail.com", []);
  const outlook = fakeServer("me@outlook.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.accounts.connect({ provider: "gmail" });
    yield* m.compose.saveDraft({
      id: "draft:1",
      accountId: GMAIL,
      message: outgoing({ text: "v1" }),
    });
    // A Mac compose window and the phone (remote web) both open the draft.
    const mac = yield* m.compose.openDraft("draft:1");
    const phone = yield* m.compose.openDraft("draft:1");
    assert.isDefined(mac.revision);
    // The phone edits and autosaves.
    const typed = "v1 + three paragraphs typed on the phone";
    const p = yield* m.compose.saveDraft({
      id: "draft:1",
      accountId: GMAIL,
      message: { ...phone.message, text: typed },
      expectedRevision: phone.revision!,
      editor: "phone",
    });
    assert.isAbove(p.revision!, phone.revision!);
    // The Mac editor, still on the older revision, autosaves one keystroke later.
    const stale = yield* m.compose
      .saveDraft({
        id: "draft:1",
        accountId: GMAIL,
        message: { ...mac.message, text: "v1." },
        expectedRevision: mac.revision,
        editor: "mac",
      })
      .pipe(Effect.flip);
    assert.strictEqual(stale._tag, "DraftConflict");
    assert.strictEqual(stale._tag === "DraftConflict" && stale.revision, p.revision);
    assert.strictEqual((yield* m.compose.openDraft("draft:1")).message.text, typed);
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.effect("an editor's own queued saves never conflict with each other", () => {
  const gmail = fakeServer("me@gmail.com", []);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.accounts.connect({ provider: "gmail" });
    const first = yield* m.compose.saveDraft({
      id: "draft:2",
      accountId: GMAIL,
      message: outgoing({ text: "a" }),
      editor: "mac",
    });
    // Two autosaves sent before either reply came back carry the same base revision.
    for (const text of ["ab", "abc"])
      yield* m.compose.saveDraft({
        id: "draft:2",
        accountId: GMAIL,
        message: outgoing({ text }),
        expectedRevision: first.revision!,
        editor: "mac",
      });
    assert.strictEqual((yield* m.compose.openDraft("draft:2")).message.text, "abc");
    // A save without a base revision (an agent, the CLI) still writes.
    yield* m.compose.saveDraft({
      id: "draft:2",
      accountId: GMAIL,
      message: outgoing({ text: "x" }),
    });
    assert.strictEqual((yield* m.compose.openDraft("draft:2")).message.text, "x");
  }).pipe(Effect.provide(TestMailbox({ gmail })));
});
