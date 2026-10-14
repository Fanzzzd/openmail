import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { Mailbox } from "./mailbox.js";
import { MIGRATIONS } from "../db/migrations.js";
import { fakeServer } from "../platform/node/fake-provider.js";
import { TestMailbox } from "../platform/node/testing.js";
import { Store } from "../store/service.js";
import { waitLimit } from "../../test-support/test-time.js";

const outgoing = {
  to: [{ name: "", address: "bob@example.com" }],
  cc: [],
  bcc: [],
  subject: "Held",
  text: "Hello",
  attachments: [],
};

it("adds draft_discards as the last migration", () => {
  expect(MIGRATIONS.at(-1)).toContain("CREATE TABLE draft_discards");
});

it("a held discard survives a crash: due ones go at start, pending ones resume and can be undone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-held-discard-"));
  const server = fakeServer("me@gmail.com");
  const layer = () =>
    TestMailbox(
      { gmail: server },
      { backgroundFlush: false, localDraftQueue: true, resumeDesktopSends: true },
      {},
      Layer.empty,
      { database: join(directory, "mail.db") },
    );
  const first = ManagedRuntime.make(layer());
  try {
    await first.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const account = yield* mailbox.connect({ provider: "gmail" });
        for (const id of ["draft:due", "draft:soon", "draft:undo"])
          yield* mailbox.saveDraft({ id, accountId: account.id, message: outgoing });
        // What a crash inside the window leaves: the stored deadline, no worker.
        yield* store.holdDraftDiscard("draft:due", Date.now() - 1000);
        yield* store.holdDraftDiscard("draft:soon", Date.now() + 300);
        yield* store.holdDraftDiscard("draft:undo", Date.now() + 60_000);
      }),
    );
  } finally {
    await first.dispose();
  }
  const reopened = ManagedRuntime.make(layer());
  try {
    await reopened.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        expect(Option.isNone(yield* store.getDraft("draft:due"))).toBe(true);
        expect(Option.isSome(yield* store.getDraft("draft:soon"))).toBe(true);
        const restored = yield* mailbox.restoreDraft("draft:undo");
        expect(restored.id).toBe("draft:undo");
        expect(Option.isNone(yield* store.draftDiscard("draft:undo"))).toBe(true);
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect(Option.isNone(await Effect.runPromise(store.getDraft("draft:soon")))).toBe(true);
          }, waitLimit),
        );
        expect(Option.isSome(yield* store.getDraft("draft:undo"))).toBe(true);
        // The undone draft saves again; the discarded ones don't come back.
        yield* mailbox.saveDraft({
          id: "draft:undo",
          accountId: restored.accountId,
          message: { ...outgoing, text: "kept" },
        });
        const late = yield* Effect.flip(
          mailbox.saveDraft({ id: "draft:due", accountId: restored.accountId, message: outgoing }),
        );
        expect(late._tag).toBe("InvalidInput");
      }),
    );
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
