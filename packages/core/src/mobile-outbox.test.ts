import { incoming as makeIncoming, TestMailbox, fakeServer } from "./platform/node/testing.js";
import { expect, it } from "vitest";
import { Effect, ManagedRuntime, Option } from "effect";
import { Mailbox } from "./portable.js";
import { Store } from "./services.js";
import { buildMobileMime } from "./platform/react-native/compose.js";
import { parseMobileMime } from "./platform/react-native/mail-codec.js";
import { SendUncertain } from "./errors.js";
import { type IncomingMessage, type OutgoingMessage } from "./domain.js";
{
  const message: OutgoingMessage = {
    to: [{ name: "王工", address: "alice@example.test" }],
    cc: [],
    bcc: [{ name: "", address: "hidden@example.test" }],
    subject: "移动邮件",
    text: "Hello",
    html: "<b>Hello</b><script>secret()</script>",
    attachments: [{ filename: "照片.png", mimeType: "image/png", content: "AQID" }],
  };

  it("retains uncertain deliveries for human review and never retries them automatically", async () => {
    const server = fakeServer("me@example.test");
    const runtime = ManagedRuntime.make(
      TestMailbox({ gmail: server }, { backgroundFlush: false, localDraftQueue: true }),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          const draft = { id: "draft:failed", accountId: account.id, message };
          yield* mailbox.queueSend(draft, 0);
          server.sendFailure = new SendUncertain({ message: "Network lost after submission" });
          yield* mailbox.flushQueuedSends();
          expect((yield* mailbox.queuedSends)[0]?.status).toBe("failed");
          yield* mailbox.flushQueuedSends();
          expect(server.sent).toEqual([]);
          expect(yield* mailbox.cancelQueuedSend(draft.id)).toBe(true);
          expect((yield* mailbox.openDraft(draft.id)).message.subject).toBe(message.subject);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("builds portable MIME with Unicode, Bcc, reply headers, safe rich text and binary attachments", async () => {
    const raw = await Effect.runPromise(
      buildMobileMime(
        { name: "Me", address: "me@example.test" },
        { ...message, mode: "replyAll" },
        { messageId: "<original@example.test>", references: "<root@example.test>" },
      ),
    );
    const parsed = await parseMobileMime(raw);
    expect(parsed.subject).toBe(message.subject);
    expect(parsed.bcc).toMatchObject({ value: [{ address: "hidden@example.test" }] });
    expect(parsed.inReplyTo).toBe("<original@example.test>");
    expect(parsed.headers.get("references")).toContain("<root@example.test>");
    expect(parsed.html).not.toContain("script");
    expect(parsed.attachments[0]).toMatchObject({
      filename: "照片.png",
      content: new Uint8Array([1, 2, 3]),
    });
    await expect(
      Effect.runPromise(
        buildMobileMime({ name: "", address: "bad\r\nBcc: stolen@example.test" }, message),
      ),
    ).rejects.toThrow("Could not build");
  });

  it("rejects an invalid queued recipient before persisting a send intent", async () => {
    const runtime = ManagedRuntime.make(TestMailbox());
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          const result = yield* mailbox
            .queueSend(
              {
                id: "draft:invalid",
                accountId: account.id,
                message: { ...message, to: [{ name: "", address: "unfinished" }] },
              },
              0,
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(yield* mailbox.queuedSends).toEqual([]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("persists queued sends and interrupted claims across database reopening", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const nodePath = await import("node:path");
    const { Layer } = await import("effect");
    const directory = mkdtempSync(nodePath.join(tmpdir(), "openmail-mobile-outbox-"));
    const server = fakeServer("me@example.test");
    const layer = () =>
      TestMailbox(
        { gmail: server },
        { backgroundFlush: false, localDraftQueue: true },
        {},
        Layer.empty,
        { database: nodePath.join(directory, "mail.db") },
      );
    const first = ManagedRuntime.make(layer());
    try {
      await first.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          yield* mailbox.queueSend({ id: "draft:persisted", accountId: account.id, message }, 0);
          yield* mailbox.queueSend({ id: "draft:interrupted", accountId: account.id, message }, 0);
          const store = yield* Store;
          const interrupted = (yield* store.queuedSends).find(
            (item) => item.id === "draft:interrupted",
          );
          if (!interrupted) throw new Error("missing intent");
          yield* store.putQueuedSend({ ...interrupted, status: "sending" });
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
          expect(yield* mailbox.queuedSends).toHaveLength(2);
          yield* mailbox.flushQueuedSends();
          expect(server.sent).toHaveLength(1);
          expect((yield* mailbox.queuedSends)[0]?.status).toBe("failed");
          expect(yield* (yield* Store).sendUncertain("draft:interrupted")).toBe(true);
          yield* mailbox.flushQueuedSends();
          expect(server.sent).toHaveLength(1);
          const interrupted = (yield* mailbox.queuedSends)[0];
          if (!interrupted) throw new Error("Missing interrupted send");
          yield* mailbox.queueSend(
            { id: interrupted.id, accountId: interrupted.accountId, message: interrupted.message },
            Date.now() + 60000,
            true,
          );
          expect((yield* mailbox.queuedSends)[0]?.status).toBe("waiting");
          expect(yield* mailbox.cancelWaitingSend("draft:interrupted")).toBe(true);
          expect(
            (yield* mailbox.openDraft("draft:interrupted")).message.attachments[0]?.content,
          ).toBe("AQID");
        }),
      );
    } finally {
      await reopened.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rechecks foreground eligibility before each queued delivery", async () => {
    const server = fakeServer("me@example.test");
    const runtime = ManagedRuntime.make(
      TestMailbox({ gmail: server }, { backgroundFlush: false, localDraftQueue: true }),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          for (const id of ["draft:first", "draft:second"])
            yield* mailbox.queueSend({ id, accountId: account.id, message }, 0);
          yield* mailbox.flushQueuedSends(() => server.sent.length === 0);
          expect(server.sent).toHaveLength(1);
          expect(yield* mailbox.queuedSends).toHaveLength(1);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects blocked Gmail attachments at queue preflight before any delivery", async () => {
    const server = fakeServer("me@example.test");
    const runtime = ManagedRuntime.make(
      TestMailbox({ gmail: server }, { localDraftQueue: true, backgroundFlush: false }),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          const result = yield* mailbox
            .queueSend(
              {
                id: "draft:blocked",
                accountId: account.id,
                message: {
                  ...message,
                  attachments: [
                    { filename: "bad.exe", mimeType: "application/octet-stream", content: "AQID" },
                  ],
                },
              },
              0,
            )
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          expect(yield* mailbox.queuedSends).toEqual([]);
          expect(server.sent).toEqual([]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("marks legacy preflight failures rejected without claiming or attempting delivery", async () => {
    const server = fakeServer("me@example.test");
    const runtime = ManagedRuntime.make(
      TestMailbox({ outlook: server }, { localDraftQueue: true, backgroundFlush: false }),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "outlook" });
          const store = yield* Store;
          const oversized = {
            ...message,
            attachments: [
              {
                filename: "large.txt",
                mimeType: "text/plain",
                content: "AAAA".repeat(1024 * 1024 + 1),
              },
            ],
          };
          const result = yield* mailbox
            .queueSend({ id: "draft:too-large", accountId: account.id, message: oversized }, 0)
            .pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          yield* store.putQueuedSend({
            id: "draft:legacy",
            accountId: account.id,
            message: oversized,
            due: 0,
            status: "waiting",
          });
          yield* mailbox.flushQueuedSends();
          expect((yield* mailbox.queuedSends)[0]?.status).toBe("rejected");
          expect(server.sent).toEqual([]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("discard removes both the editable draft and its queued send intent", async () => {
    const server = fakeServer("me@example.test");
    const runtime = ManagedRuntime.make(
      TestMailbox({ gmail: server }, { localDraftQueue: true, backgroundFlush: false }),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect({ provider: "gmail" });
          const input = { id: "draft:discard", accountId: account.id, message };
          yield* mailbox.queueSend(input, 0);
          expect(
            (yield* mailbox.threads({ accountIds: [account.id], mailbox: "drafts" })).some(
              (row) => row.id === input.id,
            ),
          ).toBe(true);
          yield* mailbox.discardDraft(input.id);
          expect(yield* mailbox.queuedSends).toEqual([]);
          expect(yield* mailbox.threads({ accountIds: [account.id], mailbox: "drafts" })).toEqual(
            [],
          );
          yield* mailbox.flushQueuedSends();
          expect(server.sent).toEqual([]);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });
}

{
  const source: IncomingMessage = makeIncoming("m", {
    threadId: "t",
    subject: "Mobile",
    from: { name: "Alice", address: "alice@example.test" },
    to: [{ name: "", address: "me@example.test" }],
    date: Date.now(),
    snippet: "body",
    bodyText: "body",
  });

  const message: OutgoingMessage = {
    to: [{ name: "王工", address: "alice@example.test" }],
    cc: [],
    bcc: [{ name: "", address: "hidden@example.test" }],
    subject: "移动邮件",
    text: "Hello",
    html: "<b>Hello</b><script>secret()</script>",
    attachments: [{ filename: "照片.png", mimeType: "image/png", content: "AQID" }],
  };

  for (const provider of ["gmail", "outlook"] as const) {
    it(`${provider}: mobile uses the same batch, undo, snooze, contact, draft and send command paths`, async () => {
      const server = fakeServer("me@example.test", [source]);
      const runtime = ManagedRuntime.make(
        TestMailbox(
          { [provider]: server },
          { imapIdle: false, backgroundFlush: false, localDraftQueue: true },
        ),
      );
      try {
        await runtime.runPromise(
          Effect.gen(function* () {
            const mailbox = yield* Mailbox;
            const account = yield* mailbox.connect({ provider });
            yield* mailbox.sync(account.id);
            const row = (yield* mailbox.threads({ accountIds: [account.id] }))[0];
            expect(row).toBeDefined();
            if (!row) throw new Error("missing thread");
            for (const op of [
              { kind: "archive" },
              { kind: "trash" },
              { kind: "read", value: true },
              { kind: "star", value: true },
            ] as const) {
              const result = yield* mailbox.modifyWithUndo([row.id], op);
              yield* mailbox.undoBatch(result.undoId);
            }
            const snooze = yield* mailbox.snoozeWithUndo([row.id], Date.now() + 86400000);
            yield* mailbox.undoBatch(snooze.undoId);
            expect((yield* mailbox.suggestContacts("alice"))[0]?.address).toBe(
              "alice@example.test",
            );
            const draft = { id: "draft:mobile", accountId: account.id, message };
            yield* mailbox.saveDraft(draft);
            yield* mailbox.sync(account.id);
            expect(server.draftLog).toEqual([]);
            expect((yield* mailbox.openDraft(draft.id)).message.html).not.toContain("script");
            expect((yield* mailbox.openDraft(draft.id)).message.attachments[0]?.content).toBe(
              "AQID",
            );
            yield* mailbox.queueSend(draft, Date.now() + 60000);
            yield* mailbox.flushQueuedSends();
            expect(server.sent).toHaveLength(0);
            expect(yield* mailbox.cancelWaitingSend(draft.id)).toBe(true);
            yield* mailbox.queueSend(draft, 0);
            yield* mailbox.flushQueuedSends();
            yield* mailbox.flushQueuedSends();
            expect(server.sent).toHaveLength(1);
            expect(server.sent[0]?.message.html).not.toContain("script");
            expect(yield* mailbox.queuedSends).toEqual([]);
            expect(Option.isNone(yield* (yield* Store).getDraft(draft.id))).toBe(true);
            expect(
              (yield* mailbox.audit(100)).some(
                (entry) => entry.action === "send" && entry.actor === "user:app",
              ),
            ).toBe(true);
          }),
        );
      } finally {
        await runtime.dispose();
      }
    });
  }
}
