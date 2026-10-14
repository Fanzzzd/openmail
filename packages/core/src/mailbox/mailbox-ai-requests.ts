/** What every AI request on a thread shares: consent checks, the model's view of the thread, cached summaries and the request deadline. */
import { sha256Hex } from "../platform/crypto.js";
import { Deferred, Duration, Effect, Option, Schema, Stream } from "effect";
import {
  mailData,
  AiLocale,
  AI_ERRORS,
  AI_PROMPT_VERSION,
  AI_REQUEST_SECONDS,
  AI_SUMMARY_INPUT,
  AI_THREAD_INPUT,
  AI_TRIAGE_INPUT,
  aiSource,
  isTriageInbox,
} from "../ai/ai.js";
import { InvalidInput } from "../domain/errors.js";
import { modelContext, modelCoverage } from "../ai/model-view.js";
import type { Store } from "../store/service.js";

export const noLocale = (): string | undefined => undefined;
export const validLocale = (locale: string | undefined) =>
  locale === undefined
    ? Effect.succeed(locale)
    : Schema.decodeUnknownEffect(AiLocale)(locale).pipe(
        Effect.mapError(() => new InvalidInput({ message: "Unsupported language." })),
      );

export type AiRequests = ReturnType<typeof makeAiRequests>;

export function makeAiRequests(
  store: Store["Service"],
  systemLocale: () => string | undefined = noLocale,
) {
  /**
   * The app's language for AI text made in the background (automatic summaries, triage
   * reasons): the language setting, or the system language when it follows the system.
   */
  const appLocale = Effect.map(store.prefs, (prefs) =>
    prefs.language === "system" ? systemLocale() : prefs.language,
  ).pipe(Effect.orElseSucceed(noLocale));
  const active = new Set<Deferred.Deferred<void>>();
  const cancel = Effect.suspend(() =>
    Effect.forEach([...active], (done) => Deferred.succeed(done, undefined), { discard: true }),
  );
  const check = (ids: readonly string[]) =>
    Effect.gen(function* () {
      const settings = yield* store.ai.accounts;
      const accounts = yield* store.listAccounts;
      if (
        ids.length === 0 ||
        ids.some(
          (id) =>
            !settings.some((a) => a.accountId === id && a.allowed) ||
            !accounts.some((a) => a.id === id && a.enabled !== false),
        )
      )
        yield* new InvalidInput({ message: AI_ERRORS.noConsent });
    });
  /** Bytes of the thread each kind of request reads. */
  const INPUT_BYTES = {
    summary: AI_SUMMARY_INPUT,
    compose: AI_THREAD_INPUT,
    triage: AI_TRIAGE_INPUT,
  };
  const input = (id: string, kind: "summary" | "compose" | "triage" = "summary", locale?: string) =>
    Effect.gen(function* () {
      const messages = yield* store.getThread(id);
      const accountId = messages[0]?.accountId ?? "";
      yield* check([accountId]);
      const view = modelContext(messages, INPUT_BYTES[kind]);
      const threadId = `${accountId}/${view.threadId}`;
      const fullContext = modelContext(messages, Number.MAX_SAFE_INTEGER);
      const coverage = modelCoverage(fullContext, view);
      const labels = [...new Set(messages.flatMap((message) => message.labels))];
      const inputHash = sha256Hex(
        mailData(
          kind === "triage"
            ? {
                thread: fullContext,
                labels: messages
                  .map((message) => ({
                    id: message.id,
                    labels: [...new Set(message.labels)].toSorted(),
                  }))
                  .toSorted((a, b) => a.id.localeCompare(b.id)),
              }
            : fullContext,
        ),
      );
      const selectedModel = yield* store.ai.model;
      const read = new Set(view.messages.map((m) => m.id));
      return {
        view,
        /** The messages the view kept, oldest first, for citations. */
        sources: messages.filter((m) => read.has(m.id)).map(aiSource),
        ...(coverage ? { coverage } : {}),
        threadId,
        accountId,
        inputHash,
        model: selectedModel,
        // A summary is cached per language: switching the app language makes a new one.
        promptVersion: locale ? `${AI_PROMPT_VERSION}:${locale}` : AI_PROMPT_VERSION,
        locale,
        triageInbox: isTriageInbox(labels),
      };
    });
  const cached = (value: {
    threadId: string;
    inputHash: string;
    model: string;
    promptVersion: string;
  }) =>
    Effect.gen(function* () {
      const row = yield* store.ai.summary(value.threadId);
      if (
        Option.isSome(row) &&
        row.value.inputHash === value.inputHash &&
        row.value.model === value.model &&
        row.value.promptVersion === value.promptVersion
      )
        return row.value;
      if (Option.isSome(row)) yield* store.ai.deleteSummary(value.threadId);
      return null;
    });
  const bounded = <A, E>(
    stream: Stream.Stream<A, E>,
    seconds = AI_REQUEST_SECONDS,
  ): Stream.Stream<A, E | InvalidInput> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stop = yield* Deferred.make<void>();
        active.add(stop);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            active.delete(stop);
          }),
        );
        // Absolute deadline, including slow tool/provider work. Interruption aborts HTTPS.
        const deadline = Effect.sleep(Duration.seconds(seconds)).pipe(
          Effect.andThen(Effect.fail(new InvalidInput({ message: "AI request timed out." }))),
        );
        return stream.pipe(Stream.interruptWhen(Effect.raceFirst(Deferred.await(stop), deadline)));
      }),
    );
  const enabled = (id: string, triage = false) =>
    Effect.gen(function* () {
      const messages = yield* store.getThread(id);
      const settings = yield* store.ai.accounts;
      return settings.some(
        (a) => a.accountId === messages[0]?.accountId && a.allowed && (!triage || a.autoTriage),
      );
    });
  return { appLocale, cancel, check, input, cached, bounded, enabled };
}
