import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { fakeServer, outgoing, TestMailbox } from "../platform/node/testing.js";
import { Mailbox } from "./mailbox.js";
import { Store } from "../store/service.js";

const GMAIL = "gmail:me@gmail.com";
const OUTLOOK = "outlook:me@outlook.com";

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

it.effect("switching From keeps the revision moving, so an older editor is still refused", () => {
  const gmail = fakeServer("me@gmail.com", []);
  const outlook = fakeServer("me@outlook.com");
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    yield* m.accounts.connect({ provider: "gmail" });
    yield* m.accounts.connect({ provider: "outlook" });
    const first = yield* m.compose.saveDraft({
      id: "draft:1",
      accountId: GMAIL,
      message: outgoing({ text: "v1" }),
      editor: "mac",
    });
    const phone = yield* m.compose.openDraft("draft:1");
    let last = first;
    for (const text of ["a", "ab", "abc"])
      last = yield* m.compose.saveDraft({
        id: "draft:1",
        accountId: GMAIL,
        message: outgoing({ text }),
        editor: "mac",
        expectedRevision: first.revision!,
      });
    // The Mac moves the draft to Outlook; the synced Gmail copy is deleted and rewritten.
    const switched = yield* m.compose.saveDraft({
      id: "draft:1",
      accountId: OUTLOOK,
      message: outgoing({ text: "abc" }),
      editor: "mac",
      expectedRevision: first.revision!,
    });
    assert.strictEqual(switched.accountId, OUTLOOK);
    assert.isAbove(switched.revision!, last.revision!);
    const stale = yield* m.compose
      .saveDraft({
        id: "draft:1",
        accountId: OUTLOOK,
        message: outgoing({ text: "phone overwrite" }),
        editor: "phone",
        expectedRevision: phone.revision!,
      })
      .pipe(Effect.flip);
    assert.strictEqual(stale._tag, "DraftConflict");
    assert.strictEqual((yield* m.compose.openDraft("draft:1")).message.text, "abc");
  }).pipe(Effect.provide(TestMailbox({ gmail, outlook })));
});

it.effect("a draft written again under a deleted id gets a revision no editor has seen", () => {
  const gmail = fakeServer("me@gmail.com", []);
  return Effect.gen(function* () {
    const m = yield* Mailbox;
    const store = yield* Store;
    yield* m.accounts.connect({ provider: "gmail" });
    const seen = new Set<number>();
    for (const text of ["a", "ab"]) {
      const saved = yield* m.compose.saveDraft({
        id: "draft:1",
        accountId: GMAIL,
        message: outgoing({ text }),
      });
      seen.add(saved.revision!);
    }
    yield* store.deleteDraft("draft:1");
    const again = yield* store.putDraft({
      id: "draft:1",
      accountId: GMAIL,
      message: outgoing({ text: "abc" }),
    });
    assert.isFalse(seen.has(again.revision));
    assert.isAbove(again.revision, Math.max(...seen));
  }).pipe(Effect.provide(TestMailbox({ gmail })));
});
