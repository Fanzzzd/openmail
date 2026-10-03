import { Effect, Stream } from "effect";
import {
  applySignature,
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
      yield* mailbox.namedSignatures,
      yield* mailbox.signatureDefaults,
      account.email,
      message.mode === "new" ? "new" : "reply",
    );
    return {
      ...message,
      text: applySignature(message.text, undefined, signature?.text, yield* mailbox.prefs),
    };
  });
}
