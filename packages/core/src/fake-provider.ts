import { Effect, Option, Stream } from "effect";

import type { IncomingMessage, MailOp, OutgoingMessage } from "./domain.js";
import type { ProviderFailure } from "./errors.js";
import type { Change, ConnectInput, ProviderAdapter } from "./services.js";
import { applyOpToLabels } from "./store.js";

/** A provider's server side, in memory. Tests read and change it directly. */
export interface FakeServer {
  email: string;
  messages: Map<string, IncomingMessage>;
  /** Every sign-in, as the adapter received it. */
  connects: ConnectInput[];
  pushed: { providerId: string; op: MailOp }[];
  sent: {
    message: OutgoingMessage;
    original: Option.Option<{ providerId: string; threadId: string }>;
  }[];
  /** The next push, send or pull fails with this, once. */
  failNext?: ProviderFailure;
}

export function fakeServer(email: string, messages: IncomingMessage[] = []): FakeServer {
  return {
    email,
    messages: new Map(messages.map((m) => [m.providerId, m])),
    connects: [],
    pushed: [],
    sent: [],
  };
}

/**
 * A provider with Gmail's label model over a FakeServer. Every pull is a full
 * pull; the cursor counts pulls so tests can see checkpoints land.
 */
export function makeFakeProvider(server: FakeServer): ProviderAdapter {
  const failOnce = Effect.suspend(() => {
    const failure = server.failNext;
    server.failNext = undefined;
    return failure ? Effect.fail(failure) : Effect.void;
  });
  return {
    connect: (input) =>
      Effect.sync(() => {
        server.connects.push(input);
        return { email: server.email, secret: "fake-token" };
      }),
    pull: (_account, cursor) =>
      Stream.unwrap(
        Effect.map(failOnce, () => {
          const next = String(Number(Option.getOrElse(cursor, () => "0")) + 1);
          const changes: Change[] = [
            { _tag: "Labels", labels: [] },
            ...[...server.messages.values()].map((message): Change => ({
              _tag: "Upsert",
              message,
            })),
            { _tag: "Progress", fetched: server.messages.size, total: server.messages.size },
            { _tag: "Cursor", cursor: next },
          ];
          return Stream.fromIterable(changes);
        }),
      ),
    push: (_account, providerId, op) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.pushed.push({ providerId, op });
          const m = server.messages.get(providerId);
          if (!m) return;
          const labels = applyOpToLabels([...m.labels], op, "gmail");
          server.messages.set(providerId, {
            ...m,
            labels,
            isUnread: labels.includes("UNREAD"),
            isStarred: labels.includes("STARRED"),
          });
        }),
      ),
    send: (_account, message, original) =>
      Effect.andThen(
        failOnce,
        Effect.sync(() => {
          server.sent.push({ message, original });
        }),
      ),
  };
}
