import { Trans } from "@lingui/react/macro";
import type { SearchMatch } from "@openmail/core/schema";

function MarkedSnippet({ match }: { match: SearchMatch }) {
  const parts = match.highlights.flatMap(({ start, end }, index) => {
    const before = match.snippet.slice(match.highlights[index - 1]?.end ?? 0, start);
    return [
      before,
      <mark key={index} className="rounded bg-amber-300/40 text-inherit">
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
