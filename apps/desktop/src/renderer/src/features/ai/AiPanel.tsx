import { useAtomValue } from "@effect/atom-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { AI_ERRORS, type AiCoverage, type AiEvent, type AiSource } from "@openmail/core/schema";
import { Cause, Effect, Fiber, Stream } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import type { Proposal, Account } from "../../../../shared/api";
import { matchesShortcut } from "../../../../shared/shortcuts";
import { platformShortcutHint, useShortcutSet } from "../../i18n/use-shortcut-text";
import { errorText, type AppError } from "../../lib/errors";
import { MailClient } from "../../state/rpc";
import { Keys } from "../../state/keys";
import { openMessageWindow, useRunMail, withMail, type MailEnv } from "../../state/mail";
import { aiSettingsAtom } from "./ai-settings";
import { Proposals } from "./lazy";
import { openAiSettings } from "./open-ai-settings";
import { isDesktop } from "../../lib/platform";
import { Dialog } from "../../ui/Dialog";
import { buttonLink, buttonPrimary, formInput } from "../../ui/styles";
import { citedParts } from "./citations";

export function useAiStream() {
  const run = useRunMail();
  const [text, setText] = useState("");
  const [sources, setSources] = useState<readonly AiSource[]>([]);
  const [model, setModel] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [stopped, setStopped] = useState<"turns" | undefined>(undefined);
  const [coverage, setCoverage] = useState<AiCoverage | undefined>(undefined);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [error, setError] = useState<AppError | null>(null);
  const fiber = useRef<Fiber.Fiber<void> | null>(null);
  const generation = useRef(0);
  const cancel = useCallback(() => {
    generation.current++;
    if (fiber.current) run(Fiber.interrupt(fiber.current));
    fiber.current = null;
    setStatus("idle");
  }, [run]);
  useEffect(
    () => () => {
      generation.current++;
      if (fiber.current) run(Fiber.interrupt(fiber.current));
    },
    [run],
  );
  const start = (
    stream: Effect.Effect<
      Stream.Stream<AiEvent, import("../../lib/errors").AppError>,
      never,
      MailEnv
    >,
  ) => {
    cancel();
    const current = generation.current;
    setText("");
    setSources([]);
    setModel("");
    setTruncated(false);
    setStopped(undefined);
    setCoverage(undefined);
    setError(null);
    setStatus("running");
    const consume = (event: AiEvent) =>
      Effect.sync(() => {
        if (current !== generation.current) return;
        switch (event._tag) {
          case "Delta":
            setText((previous) => previous + event.text);
            break;
          case "Sources":
            setSources(event.sources);
            break;
          case "Done":
            setModel(event.model);
            setTruncated(event.truncated);
            setStopped(event.stopped);
            setCoverage(event.coverage);
            setStatus("done");
            break;
        }
      });
    fiber.current = run(
      stream.pipe(
        Effect.flatMap((events) => Stream.runForEach(events, consume)),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (current !== generation.current) return;
            const found = Cause.findErrorOption(cause);
            setError(found._tag === "Some" ? found.value : null);
            setStatus("failed");
          }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            if (current === generation.current) setStatus((s) => (s === "running" ? "idle" : s));
          }),
        ),
      ),
    );
  };
  return { text, sources, model, truncated, stopped, coverage, status, error, start, cancel };
}

/** Failures the person fixes in Settings → AI Access: the key or an account's consent. */
const SETTINGS_ERRORS: ReadonlySet<string> = new Set([
  AI_ERRORS.noKey,
  AI_ERRORS.noConsent,
  AI_ERRORS.invalidKey,
]);

/** Under a summary of a thread too long to read whole: which messages it read. */
function SummaryCoverage({ coverage }: { coverage: AiCoverage | undefined }) {
  if (!coverage) return null;
  const { kept, total } = coverage;
  return (
    <p className="text-footnote text-a11y-muted">
      <Plural
        value={total}
        one={`Covers the newest ${kept} of # message`}
        other={`Covers the newest ${kept} of # messages`}
      />
    </p>
  );
}

/**
 * A link-styled button that opens Settings → AI Access. The web build has no AI Access tab (keys
 * stay on the Mac), so there it says where to set AI up instead.
 */
export function AiAccessLink({ onOpen }: { onOpen?: () => void }) {
  if (!isDesktop())
    return (
      <span>
        <Trans>Set up AI on your Mac in Settings → AI Access.</Trans>
      </span>
    );
  return (
    <button
      type="button"
      className={buttonLink}
      onClick={() => {
        onOpen?.();
        openAiSettings();
      }}
    >
      <Trans>Open AI Access</Trans>
    </button>
  );
}

/** "Alice · Oct 14, 2026, 9:30 AM": who sent the source and when, in local time. */
function useSourceLabel() {
  const { i18n } = useLingui();
  return (source: AiSource) =>
    `${source.from} · ${i18n.date(source.date, { dateStyle: "medium", timeStyle: "short" })}`;
}

/**
 * AI text with each [message id] citation as a small numbered link to that source. The numbers
 * match the source list below the text.
 */
function CitedText({
  text,
  sources,
  openSource,
  busy = false,
}: {
  text: string;
  sources: readonly AiSource[];
  openSource: (id: string) => void;
  busy?: boolean;
}) {
  const { t } = useLingui();
  const label = useSourceLabel();
  return (
    <p aria-busy={busy} className="whitespace-pre-wrap">
      {citedParts(text, sources).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : (
          <sup key={i} className="text-footnote">
            {part.numbers.map((n) => {
              const source = sources[n - 1];
              if (!source) return null;
              const name = label(source);
              return (
                <button
                  key={n}
                  type="button"
                  className="px-px text-a11y-accent hover:underline"
                  aria-label={t`Source ${n}: ${name}`}
                  title={name}
                  onClick={() => openSource(source.id)}
                >
                  [{n}]
                </button>
              );
            })}
          </sup>
        ),
      )}
    </p>
  );
}

/** The numbered sources, by sender and local time; the subject too when they differ. */
function SourceList({
  sources,
  openSource,
}: {
  sources: readonly AiSource[];
  openSource: (id: string) => void;
}) {
  const { t } = useLingui();
  const label = useSourceLabel();
  if (!sources.length) return null;
  const oneSubject = sources.every((source) => source.subject === sources[0]?.subject);
  return (
    <ol className="space-y-0.5 text-footnote">
      {sources.map((source, i) => (
        <li key={source.id}>
          <button
            type="button"
            className="text-left text-a11y-accent hover:underline"
            onClick={() => openSource(source.id)}
          >
            [{i + 1}] {label(source)}
          </button>
          {!oneSubject && (
            <span className="text-a11y-muted"> · {source.subject || t`(No subject)`}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

export function AiOutput({
  result,
  openSource,
}: {
  result: ReturnType<typeof useAiStream>;
  openSource: (id: string) => void;
}) {
  const { t, i18n } = useLingui();
  const model = result.model;
  return (
    <div className="space-y-2">
      <output aria-atomic="true" className="sr-only">
        {result.status === "running"
          ? t`Generating…`
          : result.status === "done"
            ? t`Generation complete`
            : ""}
      </output>
      <CitedText
        text={result.text}
        sources={result.sources}
        openSource={openSource}
        busy={result.status === "running"}
      />
      {model && (
        <p className="text-footnote text-a11y-muted">
          <Trans>Generated by {model}</Trans>
        </p>
      )}
      <SummaryCoverage coverage={result.coverage} />
      {result.truncated && (
        <output>
          {result.stopped === "turns" ? (
            <Trans>
              The assistant used all its steps before it finished. Ask a narrower question.
            </Trans>
          ) : (
            <Trans>Output truncated at the token limit. It was not cached.</Trans>
          )}
        </output>
      )}
      {result.status === "failed" && (
        <div role="alert" className="space-y-1">
          <p>
            {result.error ? (
              errorText(i18n, result.error)
            ) : (
              <Trans>
                AI request failed. Check account permissions and your API key, then try again.
              </Trans>
            )}
          </p>
          {result.error && SETTINGS_ERRORS.has(result.error.message) && <AiAccessLink />}
        </div>
      )}
      {result.status === "running" && (
        <button type="button" onClick={result.cancel}>{t`Cancel`}</button>
      )}
      <SourceList sources={result.sources} openSource={openSource} />
    </div>
  );
}

export function ThreadSummary({ id, accountId }: { id: string; accountId: string }) {
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  if (!settings?.accounts.some((a) => a.accountId === accountId && a.allowed)) return null;
  return <AllowedThreadSummary id={id} keyConfigured={settings.keyConfigured} />;
}

function AllowedThreadSummary({ id, keyConfigured }: { id: string; keyConfigured: boolean }) {
  const run = useRunMail();
  // Summaries come back, and are cached, in the UI language.
  const { i18n } = useLingui();
  const locale = i18n.locale;
  const cached = AsyncResult.getOrElse(
    useAtomValue(
      MailClient.query("AiSummary", { id, locale }, { reactivityKeys: [Keys.ai, Keys.thread] }),
    ),
    () => null,
  );
  const result = useAiStream();
  const model = cached?.model ?? "";
  const open = (sourceId: string) => run(openMessageWindow(sourceId));
  return (
    <section className="mb-4 space-y-2 rounded border border-violet-500/20 p-3">
      <button
        type="button"
        disabled={!keyConfigured || result.status === "running"}
        onClick={() =>
          result.start(withMail((call) => Effect.succeed(call("Summarize", { id, locale }))))
        }
      >
        <Trans>Summarize</Trans>
      </button>
      {!keyConfigured && (
        <p className="text-footnote text-a11y-muted">
          <Trans>Add an Anthropic API key in Settings → AI Access to summarize.</Trans>{" "}
          <AiAccessLink />
        </p>
      )}
      {result.status === "idle" && cached && (
        <>
          <CitedText text={cached.text} sources={cached.sources ?? []} openSource={open} />
          <p className="text-footnote text-a11y-muted">
            <Trans>Generated by {model}</Trans>
          </p>
          <SummaryCoverage coverage={cached.coverage} />
          <SourceList sources={cached.sources ?? []} openSource={open} />
        </>
      )}
      <AiOutput result={result} openSource={open} />
    </section>
  );
}

export function Assistant({
  accounts,
  proposals,
  onOpenDraft,
}: {
  accounts: readonly Account[];
  proposals: readonly Proposal[];
  onOpenDraft: (proposal: Proposal) => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState(false);
  const [question, setQuestion] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const settings = AsyncResult.getOrElse(useAtomValue(aiSettingsAtom), () => null);
  const result = useAiStream();
  const eligible = accounts.filter((a) =>
    settings?.accounts.some((s) => s.accountId === a.id && s.allowed),
  );
  const ids = selected.filter((id) => eligible.some((a) => a.id === id));
  const shortcutSet = useShortcutSet();
  const hint = platformShortcutHint(shortcutSet, "assistant");
  const toggleKey = useEffectEvent((event: KeyboardEvent) => {
    if (!matchesShortcut(shortcutSet, "assistant", event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setOpen((previous) => !previous);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => toggleKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  const { cancel } = result;
  useEffect(() => {
    if (!open) cancel();
  }, [open, cancel]);
  if (!open) return null;
  return (
    <>
      <Dialog
        aria-label={t`Mail assistant`}
        onClose={() => setOpen(false)}
        maxHeight="720px"
        className="w-[min(620px,calc(100vw-48px))] space-y-4 overflow-y-auto p-5"
      >
        <h2 className="flex items-baseline gap-2 text-headline font-semibold">
          <Trans>Mail assistant</Trans>
          {hint && (
            <kbd className="font-sans text-footnote font-normal text-a11y-muted">{hint}</kbd>
          )}
        </h2>
        {settings && !settings.keyConfigured ? (
          <div className="space-y-2 rounded border border-violet-500/20 p-4">
            <p className="font-medium">
              <Trans>Set up built-in AI</Trans>
            </p>
            <p className="text-a11y-muted">
              <Trans>
                Add your Anthropic API key in Settings → AI Access, then allow the accounts the
                assistant may read.
              </Trans>
            </p>
            <AiAccessLink onOpen={() => setOpen(false)} />
          </div>
        ) : (
          <p className="text-footnote text-a11y-muted">
            <Trans>
              Select accounts allowed in Settings → AI Access. The assistant searches mail and
              suggests drafts, labels or archiving. You approve each one in AI suggestions.
            </Trans>
          </p>
        )}
        {settings?.keyConfigured && !eligible.length && (
          <p className="text-footnote text-a11y-muted">
            <Trans>Allow an account in Settings → AI Access to ask about its mail.</Trans>{" "}
            <AiAccessLink onOpen={() => setOpen(false)} />
          </p>
        )}
        {eligible.map((account) => (
          <label key={account.id} className="mr-4 inline-flex items-center gap-2">
            <input
              type="checkbox"
              className="size-3.5 accent-blue-600"
              checked={ids.includes(account.id)}
              disabled={result.status === "running"}
              onChange={(event) =>
                setSelected((previous) =>
                  event.target.checked
                    ? [...previous, account.id]
                    : previous.filter((id) => id !== account.id),
                )
              }
            />
            {account.email}
          </label>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (ids.length && question.trim())
              result.start(
                withMail((call) =>
                  Effect.succeed(
                    call("AskAi", {
                      input: { question: question.trim(), accountIds: ids, locale: i18n.locale },
                    }),
                  ),
                ),
              );
          }}
          className="space-y-3"
        >
          <textarea
            aria-label={t`Ask about your mail`}
            maxLength={4000}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t`Ask about your mail`}
            className={`min-h-20 resize-y py-1.5 ${formInput}`}
          />
          <div className="flex justify-end">
            <button
              type="submit"
              className={buttonPrimary}
              disabled={
                !ids.length ||
                !question.trim() ||
                !settings?.keyConfigured ||
                result.status === "running"
              }
            >
              <Trans>Ask</Trans>
            </button>
          </div>
        </form>
        <AiOutput result={result} openSource={(id) => run(openMessageWindow(id))} />
        <div className="border-t border-separator pt-3">
          <button type="button" onClick={() => setReview(true)} className={buttonLink}>
            <Trans>Review AI suggestions</Trans> ({proposals.length})
          </button>
        </div>
      </Dialog>
      {review && (
        <Proposals
          accounts={accounts}
          proposals={proposals}
          onClose={() => setReview(false)}
          onOpenDraft={(proposal) => {
            setOpen(false);
            setReview(false);
            onOpenDraft(proposal);
          }}
        />
      )}
    </>
  );
}
