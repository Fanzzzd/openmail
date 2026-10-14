import { Effect, Stream } from "effect";
import {
  applySignature,
  agentRecipientWarnings,
  hasRecipientWarnings,
  signatureDefault,
  type AiEvent,
  type Mailbox,
  type OutgoingMessage,
} from "@openmail/core/portable";

/** A cancelled or incomplete response cannot become an accepted draft change. */
export function aiResponse<E>(stream: Stream.Stream<AiEvent, E>) {
  return Effect.gen(function* () {
    const result = { text: "", complete: false };
    yield* Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        if (event._tag === "Delta") result.text += event.text;
        if (event._tag === "Done") result.complete = !event.truncated;
      }),
    );
    if (!result.complete || !result.text.trim()) throw new Error("Incomplete AI response");
    return result.text;
  });
}

/** Existing drafts retain their signature. New compose sessions use the shared defaults. */
export function signedMobileMessage(
  mailbox: Mailbox["Service"],
  accountId: string,
  message: OutgoingMessage,
) {
  return Effect.gen(function* () {
    const account = (yield* mailbox.accounts).find((entry) => entry.id === accountId);
    if (!account) return message;
    const signature = signatureDefault(
      yield* mailbox.compose.namedSignatures,
      yield* mailbox.compose.signatureDefaults,
      account.email,
      message.mode === "new" ? "new" : "reply",
    );
    return {
      ...message,
      text: applySignature(message.text, undefined, signature?.text, yield* mailbox.app.prefs),
    };
  });
}

/** The compose screen must await this decision before showing its send confirmation. */
export async function reviewAgentRecipients(
  warnings: ReturnType<typeof agentRecipientWarnings>,
  confirm: () => Promise<boolean>,
): Promise<boolean> {
  return hasRecipientWarnings(warnings) ? confirm() : true;
}

/** Expunged originals still require review of every current recipient. */
export function mobileRecipientWarnings(
  mailbox: Mailbox["Service"],
  accountId: string,
  message: OutgoingMessage,
) {
  return Effect.gen(function* () {
    const known = yield* mailbox.knownSenders(
      accountId,
      [...message.to, ...message.cc, ...message.bcc].map((a) => a.address),
    );
    const thread = message.agentOrigin?.replyTo
      ? yield* mailbox
          .thread(message.agentOrigin.replyTo)
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed([])))
      : [];
    return agentRecipientWarnings(message, known, thread);
  });
}
