import { Trans, useLingui } from "@lingui/react/macro";
import type { SearchMatch, ThreadSummary } from "@openmail/core/schema";
import { previewText } from "../format";

function MarkedSnippet({ match }: { match: SearchMatch }) {
  const parts = match.highlights.flatMap(({ start, end }, index) => {
    const before = match.snippet.slice(match.highlights[index - 1]?.end ?? 0, start);
    return [
      before,
      // Opaque with its own text color: a tint under inherited text fails AA on dark and accent rows.
      <mark key={index} className="rounded bg-amber-200 text-neutral-950">
        {match.snippet.slice(start, end)}
      </mark>,
    ];
  });
  return (
    <>
      {parts}
      {match.snippet.slice(match.highlights.at(-1)?.end ?? 0)}
    </>
  );
}

export const attachmentMatches = (matches: readonly SearchMatch[] = []) =>
  matches.filter((match) => match.source === "attachment");

/**
 * A thread row lists each attachment text once. A forwarded copy of a message
 * carries the same file, so its match would repeat the row above it.
 */
export function distinctAttachmentMatches(matches: readonly SearchMatch[] = []) {
  const seen = new Set<string>();
  return attachmentMatches(matches).filter((match) => {
    const key = JSON.stringify([match.attachmentName, match.snippet]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keeps at most `lead` characters before the first mark, so a one-line row still shows it. */
function leadIn(match: SearchMatch, lead: number): SearchMatch {
  const first = match.highlights[0];
  if (!first || first.start <= lead + 1) return match;
  const start = first.start - lead;
  // Start at a word when the lead has a space; CJK text has none, so cut between characters.
  const space = match.snippet.slice(start, first.start).search(/\s\S/);
  const cut =
    space >= 0
      ? start + space + 1
      : /[\uDC00-\uDFFF]/.test(match.snippet[start] ?? "")
        ? start - 1
        : start;
  const shift = cut - 1;
  return {
    ...match,
    snippet: `…${match.snippet.slice(cut)}`,
    highlights: match.highlights.map((range) => ({
      start: range.start - shift,
      end: range.end - shift,
    })),
  };
}

/**
 * Without `lead` the snippet wraps as running text. With it, the snippet fits one
 * line: the source label takes at most half and each part truncates on its own.
 */
export function SearchSnippet({ match: full, lead }: { match: SearchMatch; lead?: number }) {
  const match = lead === undefined ? full : leadIn(full, lead);
  const attachmentName = match.source === "attachment" ? match.attachmentName : "";
  const source = match.source === "attachment" && (
    <Trans
      context="search match source"
      comment="Attachment filename followed by a localized colon before the visible text snippet."
    >
      In attachment {attachmentName}:
    </Trans>
  );
  if (lead !== undefined)
    return (
      <span className="flex min-w-0 gap-1">
        {source && <span className="max-w-1/2 shrink-0 truncate">{source}</span>}
        <span className="min-w-0 flex-1 truncate">
          <MarkedSnippet match={match} />
        </span>
      </span>
    );
  return (
    <>
      {source && <>{source} </>}
      <MarkedSnippet match={match} />
    </>
  );
}

const FIELDS = ["subject", "sender", "body", "filename", "attachment"] as const;
type MatchField = (typeof FIELDS)[number];

/** Where the query matched, in a fixed order, each field once. */
const matchedFields = (matches: readonly SearchMatch[] = []): MatchField[] =>
  FIELDS.filter((field) => matches.some((match) => match.source === field));

/** Plain text with the match's marks when the match covers all of it, as for a short subject. */
export function MatchedText({ text, match }: { text: string; match: SearchMatch | undefined }) {
  return match && match.snippet === text.replace(/\s+/g, " ").trim() ? (
    <MarkedSnippet match={match} />
  ) : (
    <>{text}</>
  );
}

/**
 * A result row's preview: which fields matched, then the message text around
 * the first hit with the query words marked. A result found only by meaning
 * says Related and marks nothing.
 */
export function SearchPreview({ thread, lead }: { thread: ThreadSummary; lead?: number }) {
  const { t } = useLingui();
  const matches = thread.searchMatches ?? [];
  const fields = matchedFields(matches);
  if (!fields.length && !thread.related) return <>{previewText(thread.snippet)}</>;
  const names: Record<MatchField, string> = {
    subject: t({ message: "Subject", context: "search match source" }),
    sender: t({ message: "Sender", context: "search match source" }),
    body: t({
      message: "Message body",
      context: "message text",
      comment: "Email message text, never an anatomical body.",
    }),
    filename: t({ message: "File name", context: "search match source" }),
    attachment: t({ message: "Attachment text", context: "search match source" }),
  };
  const body = matches.find((match) => match.source === "body");
  return (
    <>
      <span className="font-medium">
        {fields.length
          ? fields.map((field) => names[field]).join(" · ")
          : t({
              message: "Related",
              context: "search match source",
              comment: "A search result found by meaning, without the search words.",
            })}
      </span>{" "}
      {body ? (
        <MarkedSnippet match={lead === undefined ? body : leadIn(body, lead)} />
      ) : (
        previewText(thread.snippet)
      )}
    </>
  );
}
