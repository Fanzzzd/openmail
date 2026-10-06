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

export function SearchSnippet({ match }: { match: SearchMatch }) {
  const attachmentName = match.source === "attachment" ? match.attachmentName : "";
  return (
    <>
      {match.source === "attachment" && (
        <>
          <Trans
            context="search match source"
            comment="Attachment filename followed by a localized colon before the visible text snippet."
          >
            In attachment {attachmentName}:
          </Trans>{" "}
        </>
      )}
      <MarkedSnippet match={match} />
    </>
  );
}
