import { expect, it } from "vitest";
import { Effect, ManagedRuntime, Stream } from "effect";
import {
  Mailbox,
  FakeModelLayer,
  type ModelRequest,
  type ModelOutput,
  messageModelText,
  AI_MODELS,
  ProviderError,
} from "@openmail/core/portable";
import { TestMailbox, fakeServer } from "@openmail/core/testing/node";
import { message } from "../../../packages/core/test-support/semantic-fixtures";
import {
  aiResponse,
  signedMobileMessage,
  reviewAgentRecipients,
  mobileRecipientWarnings,
} from "./ai-workflows";
import { composeMessage } from "./workflows";
import { pageQuery } from "./paging";

const incoming = message({
  subject: "Mobile AI",
  from: { name: "Alice", address: "alice@example.test" },
  to: [],
  date: Date.now(),
  snippet: "Visible decision",
  bodyText: "Visible decision HIDDEN_SECRET",
  bodyHtml:
    '<p>Visible decision</p><span style="display:none">HIDDEN_SECRET</span><img src="https://private.test/image">',
  labels: ["INBOX", "UNREAD"],
  attachments: [{ filename: "PRIVATE_ATTACHMENT.pdf", mimeType: "application/pdf", size: 12 }],
});
const finish = (text: string) =>
  Stream.fromIterable<ModelOutput>([
    { _tag: "Delta", text },
    { _tag: "Finished", reason: "stop" },
  ]);

it("mobile AI is off by default, uses selected models and visible thread text, and stops after consent is revoked", async () => {
  const requests: ModelRequest[] = [];
  const runtime = ManagedRuntime.make(
    TestMailbox(
      { gmail: fakeServer("me@example.test", [incoming]) },
      { backgroundFlush: false, localDraftQueue: true },
      {},
      FakeModelLayer((request) => {
        requests.push(request);
        return finish("Plain summary [message] https://example.test/image");
      }),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.sync();
        const id = `${account.id}/m`;
        const before = yield* mailbox.ai.aiSettings;
        expect(before.accounts.every((setting) => !setting.allowed)).toBe(true);
        expect((yield* aiResponse(mailbox.ai.summarize(id)).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(
          (yield* aiResponse(
            mailbox.ai.askAi({ question: "Explain", accountIds: [account.id], threadId: id }),
          ).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(requests).toHaveLength(0);
        yield* mailbox.ai.setAiKey("private-anthropic-key");
        yield* mailbox.ai.setAiAccount({
          accountId: account.id,
          allowed: true,
          autoSummaries: false,
        });
        yield* mailbox.ai.setAiModel(AI_MODELS[2]);
        expect(yield* aiResponse(mailbox.ai.summarize(id))).toContain("https://example.test/image");
        yield* aiResponse(
          mailbox.ai.askAi({
            question: "Explain this thread",
            accountIds: [account.id],
            threadId: id,
          }),
        );
        expect(requests).toHaveLength(2);
        for (const request of requests) {
          expect(request.model).toBe(AI_MODELS[2]);
          expect(request.prompt).toContain("Visible decision");
          expect(request.prompt).not.toMatch(/HIDDEN_SECRET|PRIVATE_ATTACHMENT|private\.test/);
        }
        expect(JSON.stringify(yield* mailbox.app.prefs)).not.toContain("private-anthropic-key");
        expect(JSON.stringify(yield* mailbox.ai.aiSettings)).not.toContain("private-anthropic-key");
        yield* mailbox.ai.setAiAccount({
          accountId: account.id,
          allowed: false,
          autoSummaries: false,
        });
        expect(yield* mailbox.ai.aiSummary(id)).toBe(null);
        expect((yield* aiResponse(mailbox.ai.summarize(id)).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
        expect(requests).toHaveLength(2);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

it("assistant archive, label and draft writes stay proposals even in allow mode, until app approval", async () => {
  let accountId = "";
  let messageId = "";
  const server = fakeServer("me@example.test", [incoming]);
  server.labels = [{ id: "Label_project", name: "Project", color: null }];
  const fake = FakeModelLayer((request) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (!request.toolkit) throw new Error("Missing toolkit");
        for (const action of ["archive", "label"] as const)
          yield* Stream.runDrain(
            yield* request.toolkit.handle("modify_threads", {
              message_ids: [messageId],
              action,
              ...(action === "label" ? { label_id: "Label_project" } : {}),
              rationale: "Human review",
            }),
          );
        yield* Stream.runDrain(
          yield* request.toolkit.handle("draft_message", {
            account_id: accountId,
            to: ["alice@example.test"],
            subject: "Reply",
            body: "Proposed reply",
            reply_to_message_id: messageId,
            rationale: "Human review",
          }),
        );
        return finish("Review my proposals");
      }),
    ).pipe(Stream.orDie),
  );
  const runtime = ManagedRuntime.make(
    TestMailbox({ gmail: server }, { backgroundFlush: false, localDraftQueue: true }, {}, fake),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        accountId = account.id;
        messageId = `${account.id}/m`;
        yield* mailbox.sync();
        yield* mailbox.ai.setAiAccount({ accountId, allowed: true, autoSummaries: false });
        yield* mailbox.setAgentWriteMode("propose");
        yield* aiResponse(
          mailbox.ai.askAi({
            question: "Suggest changes",
            accountIds: [accountId],
            threadId: messageId,
          }),
        );
        const proposals = yield* mailbox.proposals;
        expect(proposals).toHaveLength(3);
        expect((yield* mailbox.reading.thread(messageId))[0]?.labels).toContain("INBOX");
        expect((yield* mailbox.reading.thread(messageId))[0]?.labels).not.toContain(
          "Label_project",
        );
        expect(server.sent).toEqual([]);
        expect(server.draftLog).toEqual([]);
        for (const proposal of proposals) {
          expect(
            (yield* mailbox.decideProposal(proposal.id, true, "cli").pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* mailbox.decideProposal(proposal.id, true, "app");
          if (proposal.command.kind === "draft") {
            const draft = yield* mailbox.compose.openDraft(`proposal:${proposal.id}`);
            expect(draft.message.text).toBe("Proposed reply");
          }
        }
        expect((yield* mailbox.reading.thread(messageId))[0]?.labels).not.toContain("INBOX");
        expect((yield* mailbox.reading.thread(messageId))[0]?.labels).toContain("Label_project");
        expect(server.sent).toEqual([]);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

it("compose help returns a proposal without overwriting the saved draft or sending", async () => {
  const requests: ModelRequest[] = [];
  const runtime = ManagedRuntime.make(
    TestMailbox(
      {},
      { backgroundFlush: false, localDraftQueue: true },
      {},
      FakeModelLayer((request) => {
        requests.push(request);
        return finish("Replacement text");
      }),
    ),
  );
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        yield* mailbox.ai.setAiAccount({
          accountId: account.id,
          allowed: true,
          autoSummaries: false,
        });
        const message = {
          ...composeMessage("new"),
          text: "Original HIDDEN_SECRET",
          html: incoming.bodyHtml,
          attachments: [
            { filename: "PRIVATE_ATTACHMENT", mimeType: "image/png", content: "PRIVATE_BYTES" },
          ],
        };
        const draft = yield* mailbox.compose.saveDraft({
          id: "draft:mobile-ai",
          accountId: account.id,
          message,
        });
        const before = (yield* mailbox.compose.openDraft(draft.id)).message;
        const text = yield* aiResponse(
          mailbox.ai.composeAi({
            accountId: account.id,
            text: messageModelText(message.text, message.html).text,
            task: { kind: "rewrite", tone: "shorter" },
          }),
        );
        expect(text).toBe("Replacement text");
        expect(requests[0]?.prompt).not.toMatch(
          /HIDDEN_SECRET|PRIVATE_ATTACHMENT|PRIVATE_BYTES|private\.test/,
        );
        expect((yield* mailbox.compose.openDraft(draft.id)).message).toEqual(before);
        yield* mailbox.compose.saveDraft({
          id: draft.id,
          accountId: account.id,
          message: { ...message, text, html: undefined },
        });
        expect((yield* mailbox.compose.openDraft(draft.id)).message.text).toBe(text);
        expect(yield* mailbox.outbox.queuedSends).toEqual([]);
      }),
    );
  } finally {
    await runtime.dispose();
  }
});

it("incomplete or truncated model output cannot become an accepted draft", async () => {
  for (const stream of [
    Stream.make({ _tag: "Delta", text: "partial" } as const),
    Stream.make(
      { _tag: "Delta", text: "partial" } as const,
      { _tag: "Done", model: AI_MODELS[0], cached: false, truncated: true } as const,
    ),
  ])
    await expect(Effect.runPromise(aiResponse(stream))).rejects.toThrow("Incomplete AI response");
});

for (const provider of ["gmail", "outlook", "imap"] as const)
  it(`${provider}: shared signature defaults and Snoozed mailbox work in mobile`, async () => {
    const runtime = ManagedRuntime.make(
      TestMailbox(
        { [provider]: fakeServer("me@example.test", [incoming]) },
        { backgroundFlush: false, localDraftQueue: true },
      ),
    );
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const mailbox = yield* Mailbox;
          const account = yield* mailbox.connect(
            provider === "imap"
              ? {
                  provider,
                  input: {
                    preset: "custom",
                    email: "me@example.test",
                    password: "private",
                    imapHost: "imap.example.test",
                    imapPort: 993,
                    smtpHost: "smtp.example.test",
                    smtpPort: 465,
                  },
                }
              : { provider },
          );
          yield* mailbox.sync();
          const signature = yield* mailbox.compose.saveNamedSignature({
            address: account.email,
            name: "Mobile",
            text: "My signature",
          });
          for (const kind of ["new", "reply"] as const)
            yield* mailbox.compose.setSignatureDefault({
              address: account.email,
              kind,
              signatureId: signature.id,
            });
          const id = `${account.id}/m`;
          const original = (yield* mailbox.reading.thread(id))[0];
          expect(
            (yield* signedMobileMessage(mailbox, account.id, composeMessage("new"))).text,
          ).toContain("My signature");
          expect(
            (yield* signedMobileMessage(
              mailbox,
              account.id,
              composeMessage("reply", original, [account.email]),
            )).text,
          ).toContain("My signature");
          yield* mailbox.compose.setSignatureDefault({
            address: account.email,
            kind: "new",
            signatureId: null,
          });
          expect(
            (yield* signedMobileMessage(mailbox, account.id, composeMessage("new"))).text,
          ).toBe("");
          yield* mailbox.organize.snoozeWithUndo([id], Date.now() + 60000);
          expect(
            (yield* mailbox.reading.threads(pageQuery(account.id, "snoozed"))).map(
              (thread) => thread.id,
            ),
          ).toContain(id);
          const unsnooze = yield* mailbox.organize.modifyWithUndo([id], { kind: "inbox" });
          expect(yield* mailbox.reading.threads(pageQuery(account.id, "snoozed"))).toEqual([]);
          yield* mailbox.organize.undoBatch(unsnooze.undoId);
          expect(
            (yield* mailbox.reading.threads(pageQuery(account.id, "snoozed"))).map(
              (thread) => thread.id,
            ),
          ).toContain(id);
        }),
      );
    } finally {
      await runtime.dispose();
    }
  });

it("mobile AI recipient review waits for an explicit answer and cancellation blocks sending", async () => {
  let finish: (approved: boolean) => void = () => {
    throw new Error("Review not started");
  };
  let proceeded = false;
  const decision = reviewAgentRecipients(
    { unfamiliar: ["new@example.test"], outsideThread: ["new@example.test"] },
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const sent = decision.then((approved) => {
    if (approved) proceeded = true;
    return null;
  });
  await Promise.resolve();
  expect(proceeded).toBe(false);
  finish(false);
  await sent;
  expect(proceeded).toBe(false);
  expect(
    await reviewAgentRecipients(
      { unfamiliar: [], outsideThread: ["known@example.test"] },
      async () => true,
    ),
  ).toBe(true);
  expect(
    await reviewAgentRecipients({ unfamiliar: [], outsideThread: [] }, async () => {
      throw new Error("No warning needed");
    }),
  ).toBe(true);
});

it("mobile reviews every recipient when the original was expunged and preserves real read errors", async () => {
  const runtime = ManagedRuntime.make(TestMailbox({ gmail: fakeServer("me@example.test", []) }));
  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const mailbox = yield* Mailbox;
        const account = yield* mailbox.connect({ provider: "gmail" });
        const message = {
          to: [{ name: "", address: "known@example.test" }],
          cc: [],
          bcc: [],
          subject: "Reply",
          text: "Body",
          attachments: [],
          agentOrigin: { recipients: ["known@example.test"], replyTo: `${account.id}/expunged` },
        };
        const warnings = yield* mobileRecipientWarnings(mailbox, account.id, message);
        expect(warnings.outsideThread).toEqual(["known@example.test"]);
        let reviewed = false;
        expect(
          yield* Effect.promise(() =>
            reviewAgentRecipients(warnings, async () => {
              reviewed = true;
              return true;
            }),
          ),
        ).toBe(true);
        expect(reviewed).toBe(true);
        const failed = {
          ...mailbox,
          reading: {
            ...mailbox.reading,
            thread: () => Effect.die(new ProviderError({ message: "Offline" })),
          },
        };
        expect(
          (yield* mobileRecipientWarnings(failed, account.id, message).pipe(Effect.exit))._tag,
        ).toBe("Failure");
      }),
    );
  } finally {
    await runtime.dispose();
  }
});
