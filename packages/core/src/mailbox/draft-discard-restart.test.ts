import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
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

it("adds draft_discards as migration 49", () => {
  expect(MIGRATIONS[48]).toContain("CREATE TABLE draft_discards");
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
        const account = yield* mailbox.accounts.connect({ provider: "gmail" });
        for (const id of ["draft:due", "draft:soon", "draft:undo"])
          yield* mailbox.compose.saveDraft({ id, accountId: account.id, message: outgoing });
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
        const restored = yield* mailbox.compose.restoreDraft("draft:undo");
        expect(restored.id).toBe("draft:undo");
        expect(Option.isNone(yield* store.draftDiscard("draft:undo"))).toBe(true);
        yield* Effect.promise(() =>
          vi.waitFor(async () => {
            expect(Option.isNone(await Effect.runPromise(store.getDraft("draft:soon")))).toBe(true);
          }, waitLimit),
        );
        expect(Option.isSome(yield* store.getDraft("draft:undo"))).toBe(true);
        // The undone draft saves again; the discarded ones don't come back.
        yield* mailbox.compose.saveDraft({
          id: "draft:undo",
          accountId: restored.accountId,
          message: { ...outgoing, text: "kept" },
        });
        const late = yield* Effect.flip(
          mailbox.compose.saveDraft({
            id: "draft:due",
            accountId: restored.accountId,
            message: outgoing,
          }),
        );
        expect(late._tag).toBe("InvalidInput");
      }),
    );
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

const reopenable = (directory: string) => {
  const server = fakeServer("me@gmail.com");
  return () =>
    TestMailbox(
      { gmail: server },
      { backgroundFlush: false, localDraftQueue: true, resumeDesktopSends: true },
      {},
      Layer.empty,
      { database: join(directory, "mail.db") },
    );
};

it("start-up finishes a discard whose tombstone was written without the draft delete", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-zombie-discard-"));
  const layer = reopenable(directory);
  let accountId = "";
  const first = ManagedRuntime.make(layer());
  try {
    await first.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        accountId = (yield* mailbox.accounts.connect({ provider: "gmail" })).id;
        yield* mailbox.compose.saveDraft({ id: "draft:zombie", accountId, message: outgoing });
        // What an older build left after a crash between its separate steps.
        yield* store.markDraftDiscarded("draft:zombie");
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
        expect(Option.isNone(yield* store.getDraft("draft:zombie"))).toBe(true);
        expect(
          (yield* store.draftDiscard("draft:zombie")).pipe(Option.map((d) => d.discarded)),
        ).toEqual(Option.some(true));
        const late = yield* Effect.flip(
          mailbox.compose.saveDraft({ id: "draft:zombie", accountId, message: outgoing }),
        );
        expect(late._tag).toBe("InvalidInput");
      }),
    );
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("a discard that fails while deleting the draft writes no tombstone", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openmail-discard-rollback-"));
  const layer = reopenable(directory);
  let accountId = "";
  const first = ManagedRuntime.make(layer());
  try {
    await first.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        accountId = (yield* mailbox.accounts.connect({ provider: "gmail" })).id;
        yield* mailbox.compose.saveDraft({ id: "draft:busy", accountId, message: outgoing });
      }),
    );
  } finally {
    await first.dispose();
  }
  // The draft delete fails after the tombstone and queued-send writes, as a busy database would.
  const db = new DatabaseSync(join(directory, "mail.db"));
  db.exec(`CREATE TRIGGER fail_draft_delete BEFORE DELETE ON drafts WHEN OLD.id = 'draft:busy'
    BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  db.close();
  const failing = ManagedRuntime.make(layer());
  try {
    await failing.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        const exit = yield* Effect.exit(mailbox.compose.discardDraft("draft:busy"));
        expect(Exit.isFailure(exit)).toBe(true);
        expect(Option.isSome(yield* store.getDraft("draft:busy"))).toBe(true);
        expect(Option.isNone(yield* store.draftDiscard("draft:busy"))).toBe(true);
        // The draft still saves, so nothing the person types is lost.
        yield* mailbox.compose.saveDraft({
          id: "draft:busy",
          accountId,
          message: { ...outgoing, text: "typed more" },
        });
      }),
    );
  } finally {
    await failing.dispose();
  }
  const fixed = new DatabaseSync(join(directory, "mail.db"));
  fixed.exec("DROP TRIGGER fail_draft_delete");
  fixed.close();
  const reopened = ManagedRuntime.make(layer());
  try {
    await reopened.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const store = yield* Store;
        expect(Option.isSome(yield* store.getDraft("draft:busy"))).toBe(true);
        yield* mailbox.compose.discardDraft("draft:busy");
        expect(Option.isNone(yield* store.getDraft("draft:busy"))).toBe(true);
        expect(Option.isSome(yield* store.draftDiscard("draft:busy"))).toBe(true);
      }),
    );
  } finally {
    await reopened.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
