import { createHash } from "node:crypto";
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect";
import {
  mailData,
  AI_INPUT_BUDGET,
  AI_PROMPT_VERSION,
  AiAccountSettings,
  AiQuestion,
  type AiEvent,
  type AiSource,
} from "./ai.js";
import { InvalidInput } from "./errors.js";
import { Mailbox, type ModelThread } from "./mailbox.js";
import type { Model } from "./model.js";
import { modelContext } from "./model-view.js";
import { MODEL_KEY } from "./secrets.js";
import type { Secrets, Store } from "./services.js";
import { AgentIdentity, AssistantToolkit, MailToolkitLayer, toModelAccount } from "./tools.js";

const isSpecialLabel = (name: string) => {
  const normalized = name
    .trim()
    .replace(/[\s_\-\\]/g, "")
    .toUpperCase();
  return (
    /^(INBOX|TRASH|SPAM|DRAFTS?|SENT|JUNK(EMAIL)?|DELETED(ITEMS|MESSAGES)?|ARCHIVE|OUTBOX|ALLMAIL|IMPORTANT|STARRED|UNREAD)$/.test(
      normalized,
    ) || /^CATEGORY(PERSONAL|SOCIAL|PROMOTIONS|UPDATES|FORUMS)$/.test(normalized)
  );
};

export function makeAiMailbox(
  store: Store["Service"],
  secrets: Secrets["Service"],
  model: Model["Service"],
  mailbox: () => Mailbox["Service"],
  changed: Effect.Effect<unknown>,
) {
  const active = new Set<Deferred.Deferred<void>>();
  const cancel = Effect.suspend(() =>
    Effect.forEach([...active], (done) => Deferred.succeed(done, undefined), { discard: true }),
  );
  const check = (ids: readonly string[]) =>
    Effect.gen(function* () {
      const settings = yield* store.ai.accounts;
      if (
        ids.length === 0 ||
        ids.some((id) => !settings.some((a) => a.accountId === id && a.allowed))
      )
        yield* new InvalidInput({
          message: "Allow sending mail text for each selected account in AI settings.",
        });
    });
  const context = (id: string) =>
    Effect.map(store.getThread(id), (messages) => modelContext(messages, 6000));
  const input = (id: string) =>
    Effect.gen(function* () {
      const messages = yield* store.getThread(id);
      const accountId = messages[0]?.accountId ?? "";
      yield* check([accountId]);
      const view = modelContext(messages, 6000);
      const threadId = `${accountId}/${view.threadId}`;
      const inputHash = createHash("sha256")
        .update(mailData(modelContext(messages, Number.MAX_SAFE_INTEGER)))
        .digest("hex");
      const selectedModel = yield* store.ai.model;
      return {
        view,
        threadId,
        accountId,
        inputHash,
        model: selectedModel,
        promptVersion: AI_PROMPT_VERSION,
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
  const bounded = <A, E>(stream: Stream.Stream<A, E>): Stream.Stream<A, E | InvalidInput> =>
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
        const deadline = Effect.sleep("60 seconds").pipe(
          Effect.andThen(Effect.fail(new InvalidInput({ message: "AI request timed out." }))),
        );
        return stream.pipe(Stream.interruptWhen(Effect.raceFirst(Deferred.await(stop), deadline)));
      }),
    );
  const summarize = (id: string) =>
    bounded(
      Stream.unwrap(
        Effect.gen(function* () {
          const value = yield* input(id);
          const previous = yield* cached(value);
          const sources: AiSource[] = value.view.messages.map((m) => ({
            id: m.id,
            subject: value.view.subject,
          }));
          const start: AiEvent = { _tag: "Sources", sources };
          if (previous)
            return Stream.make(
              start,
              { _tag: "Delta", text: previous.text },
              { _tag: "Done", model: previous.model, cached: true, truncated: false },
            );
          let text = "";
          let reason: "stop" | "length" = "length";
          const body = model
            .stream({
              model: value.model,
              prompt: `Summarize the conversation, decisions and next steps. Cite message ids.\n${mailData(value.view)}`,
              check: check([value.accountId]),
            })
            .pipe(
              Stream.tap((output) =>
                Effect.sync(() => {
                  if (output._tag === "Finished") reason = output.reason;
                  else text += output.text;
                }),
              ),
              Stream.filter((output) => output._tag === "Delta"),
              Stream.map((output): AiEvent => ({ _tag: "Delta", text: output.text })),
            );
          const finish = Stream.fromEffect(
            Effect.gen(function* () {
              yield* check([value.accountId]);
              if (reason === "length")
                return {
                  _tag: "Done",
                  model: value.model,
                  cached: false,
                  truncated: true,
                } satisfies AiEvent;
              const latest = yield* input(id);
              if (latest.inputHash !== value.inputHash)
                return yield* new InvalidInput({
                  message: "The thread changed. Summarize it again.",
                });
              yield* store.ai.putSummary(value.accountId, {
                threadId: value.threadId,
                inputHash: value.inputHash,
                model: value.model,
                promptVersion: value.promptVersion,
                text,
              });
              yield* changed;
              return {
                _tag: "Done",
                model: value.model,
                cached: false,
                truncated: false,
              } satisfies AiEvent;
            }),
          );
          return Stream.concat(Stream.make(start), Stream.concat(body, finish));
        }),
      ),
    );

  const askAi = (raw: AiQuestion) =>
    bounded(
      Stream.unwrap(
        Effect.gen(function* () {
          const question = yield* Schema.decodeUnknownEffect(AiQuestion)(raw).pipe(
            Effect.mapError(
              () => new InvalidInput({ message: "Enter a question and select accounts." }),
            ),
          );
          const ids = [...new Set(question.accountIds)];
          yield* check(ids);
          const selectedModel = yield* store.ai.model;
          let bytesLeft = AI_INPUT_BUDGET - Buffer.byteLength(question.question) - 12_000;
          let calls = 0;
          const sources = new Map<string, AiSource>();
          const guard = Effect.gen(function* () {
            yield* check(ids);
            if (++calls > 12) yield* new InvalidInput({ message: "AI tool budget exceeded." });
          });
          const scope = (requested?: readonly string[]) =>
            requested ? requested.filter((id) => ids.includes(id)) : ids;
          const budget = <A>(value: A) =>
            Effect.gen(function* () {
              bytesLeft -= Buffer.byteLength(mailData(value));
              if (bytesLeft < 0)
                return yield* new InvalidInput({
                  message: "AI input budget exceeded. Ask about fewer messages.",
                });
              return value;
            });
          const m = mailbox();
          const read = (id: string, maxChars = 6000) =>
            Effect.gen(function* () {
              yield* guard;
              const view = yield* context(id);
              yield* check([view.accountId]);
              if (!ids.includes(view.accountId))
                return yield* new InvalidInput({
                  message: "This account is outside the selected accounts.",
                });
              const safe: ModelThread = {
                ...view,
                labels: [],
                messages: view.messages.map((message) => ({
                  ...message,
                  text: mailData({ text: message.text.slice(0, Math.min(maxChars, 6000)) }),
                  attachments: [],
                })),
              };
              for (const message of safe.messages)
                sources.set(message.id, { id: message.id, subject: safe.subject });
              return yield* budget(safe);
            });
          const scoped: Mailbox["Service"] = {
            ...m,
            accounts: Effect.andThen(
              guard,
              Effect.flatMap(m.accounts, (accounts) => {
                const selected = accounts.filter((a) => ids.includes(a.id));
                return budget(selected.map(toModelAccount)).pipe(Effect.as(selected));
              }),
            ).pipe(Effect.catch(() => Effect.succeed([]))),
            labels: (accountIds) =>
              Effect.andThen(guard, Effect.flatMap(m.labels(scope(accountIds)), budget)).pipe(
                Effect.catch(() => Effect.succeed([])),
              ),
            threads: (q) =>
              Effect.gen(function* () {
                yield* guard;
                const accountIds = scope(q.accountIds);
                if (accountIds.length === 0) return [];
                const found = yield* m.threads({
                  ...q,
                  accountIds,
                  limit: Math.min(q.limit ?? 5, 5),
                });
                const safe = found.map((thread) => ({
                  ...thread,
                  snippet: "",
                  attachmentNames: [],
                  derivedMatches: [],
                }));
                for (const thread of safe)
                  sources.set(thread.id, { id: thread.id, subject: thread.subject });
                return yield* budget(safe);
              }),
            threadForModel: read,
            perform: (command, actor) =>
              Effect.gen(function* () {
                yield* guard;
                if (command.kind !== "draft" && command.kind !== "modify")
                  return yield* new InvalidInput({
                    message: "The assistant can only propose drafts, labels and archive.",
                  });
                if (command.kind === "modify") {
                  if (command.op.kind !== "archive" && command.op.kind !== "label")
                    return yield* new InvalidInput({
                      message: "Only archive and label proposals are available.",
                    });
                  if (command.threads.length > 20)
                    return yield* new InvalidInput({ message: "Too many threads in a proposal." });
                  const op = command.op;
                  if (op.kind === "label" && !op.value)
                    return yield* new InvalidInput({
                      message: "The assistant can only add user labels in Gmail.",
                    });
                  for (const id of command.threads) {
                    const view = yield* read(id);
                    if (op.kind === "label") {
                      const account = yield* store.getAccount(view.accountId);
                      const labels = yield* store.listLabels([account.id]);
                      const label = labels.find(
                        (item) => item.accountId === account.id && item.id === op.labelId,
                      );
                      if (
                        account.provider !== "gmail" ||
                        !label ||
                        isSpecialLabel(label.id) ||
                        isSpecialLabel(label.name)
                      )
                        return yield* new InvalidInput({
                          message: "The assistant can only add user labels in Gmail.",
                        });
                    }
                  }
                } else {
                  if (!ids.includes(command.accountId))
                    return yield* new InvalidInput({
                      message: "This account is outside the selected accounts.",
                    });
                  if (command.message.inReplyTo) yield* read(command.message.inReplyTo);
                }
                return yield* m.perform(command, {
                  ...actor,
                  kind: "agent",
                  surface: "rule",
                  name: "openmail-assistant",
                });
              }),
          };
          const toolkit = yield* AssistantToolkit.pipe(
            Effect.provide(
              MailToolkitLayer.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(Mailbox, scoped),
                    AgentIdentity.fixed("rule", "openmail-assistant"),
                  ),
                ),
              ),
            ),
          );
          let truncated = true;
          const body = model
            .stream({ model: selectedModel, prompt: question.question, toolkit, check: check(ids) })
            .pipe(
              Stream.tap((output) =>
                Effect.sync(() => {
                  if (output._tag === "Finished") truncated = output.reason === "length";
                }),
              ),
              Stream.filter((output) => output._tag === "Delta"),
              Stream.map((output): AiEvent => ({ _tag: "Delta", text: output.text })),
            );
          return Stream.concat(
            body,
            Stream.suspend(() =>
              Stream.make(
                { _tag: "Sources", sources: [...sources.values()] },
                { _tag: "Done", model: selectedModel, cached: false, truncated },
              ),
            ),
          );
        }),
      ),
    );
  return {
    aiSettings: Effect.gen(function* () {
      return {
        keyConfigured: Option.isSome(yield* secrets.get(MODEL_KEY)),
        model: yield* store.ai.model,
        accounts: yield* store.ai.accounts,
      };
    }),
    setAiKey: (key: string) =>
      Effect.gen(function* () {
        if (key.length > 4096 || /[\r\n]/.test(key))
          yield* new InvalidInput({ message: "Enter a single API key." });
        yield* cancel;
        yield* (key.trim() ? secrets.set(MODEL_KEY, key.trim()) : secrets.remove(MODEL_KEY)).pipe(
          Effect.catchCause(() =>
            Effect.fail(
              new InvalidInput({ message: "Could not save the API key in the system keychain." }),
            ),
          ),
        );
        yield* changed;
      }),
    setAiAccount: (raw: AiAccountSettings) =>
      Effect.gen(function* () {
        const settings = yield* Schema.decodeUnknownEffect(AiAccountSettings)(raw).pipe(
          Effect.mapError(() => new InvalidInput({ message: "Invalid AI account settings." })),
        );
        yield* store.getAccount(settings.accountId);
        yield* cancel;
        yield* store.transaction(
          Effect.gen(function* () {
            yield* store.ai.setAccount(settings);
            if (!settings.allowed) yield* store.ai.deleteAccountResults(settings.accountId);
          }),
        );
        yield* changed;
      }),
    setAiModel: (name: import("./ai.js").AiModelName) =>
      Effect.andThen(cancel, Effect.andThen(store.ai.setModel(name), changed)).pipe(Effect.asVoid),
    aiSummary: (id: string) => Effect.flatMap(input(id), cached),
    summarize,
    askAi,
    autoSummaries: (ids: readonly string[]) =>
      Effect.gen(function* () {
        const settings = yield* store.ai.accounts;
        if (
          !settings.some((a) => a.allowed && a.autoSummaries) ||
          Option.isNone(yield* secrets.get(MODEL_KEY))
        )
          return;
        // At most three new threads per arrival batch, sequentially, no retries.
        for (const id of ids.slice(0, 3)) {
          const thread = yield* store.getThread(id).pipe(Effect.option);
          const accountId = Option.isSome(thread) ? thread.value[0]?.accountId : undefined;
          if (settings.some((a) => a.accountId === accountId && a.allowed && a.autoSummaries))
            yield* Stream.runDrain(summarize(id)).pipe(Effect.catchCause(() => Effect.void));
        }
      }),
  };
}
