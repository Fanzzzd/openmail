/** Merges and ranks results from FTS, server search and the semantic routes. */

import type { ThreadSummary } from "../domain/message.js";

/** One identity for conversation grouping, flat search and all fusion routes. */
export const keyOf = (
  thread: Pick<ThreadSummary, "id" | "accountId" | "threadId">,
  flat = false,
): string => (flat ? thread.id : `${thread.accountId}/${thread.threadId}`);

export function mergeSearchResults(
  local: readonly ThreadSummary[],
  remote: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  if (local.some((row) => (row.derivedMatches?.length ?? 0) > 0))
    return reciprocalRankFusion(local, remote, flat);
  const found = new Map<string, ThreadSummary>();
  for (const row of [...local, ...remote]) {
    const key = keyOf(row, flat);
    const previous = found.get(key);
    const next = !previous || previous.date < row.date ? row : previous;
    const derivedMatches = previous?.derivedMatches ?? row.derivedMatches;
    found.set(key, { ...next, ...(derivedMatches ? { derivedMatches } : {}) });
  }
  return [...found.values()].toSorted((a, b) => b.date - a.date);
}

const SEARCH_MATCH_LIMIT = 20;

function combineMatches<A>(left: readonly A[] = [], right: readonly A[] = []): readonly A[] {
  if (left === right || right.length === 0)
    return left.length <= SEARCH_MATCH_LIMIT ? left : left.slice(0, SEARCH_MATCH_LIMIT);
  if (left.length === 0)
    return right.length <= SEARCH_MATCH_LIMIT ? right : right.slice(0, SEARCH_MATCH_LIMIT);
  return [...new Map([...left, ...right].map((hit) => [JSON.stringify(hit), hit])).values()].slice(
    0,
    SEARCH_MATCH_LIMIT,
  );
}

/** Weighted RRF combines independent BM25 orders without comparing corpus score scales. */
export function reciprocalRankFusion(
  body: readonly ThreadSummary[],
  derived: readonly ThreadSummary[],
  flat = false,
  exactAttachments: ReadonlySet<string> = new Set(),
  exactMail: ReadonlySet<string> = new Set(),
): ThreadSummary[] {
  const scores = new Map<string, { thread: ThreadSummary; score: number }>();
  // Keep even the last mail candidate above the strongest ordinary OCR-only hit.
  const mailWeight = Math.max(2, (60 + body.length) / 60);
  const phraseBonus = 1.5 * mailWeight - 1;
  for (const [index, list] of [body, derived].entries()) {
    const seen = new Set<string>();
    for (const [rank, thread] of list.entries()) {
      const key = keyOf(thread, flat);
      if (seen.has(key)) continue;
      seen.add(key);
      const old = scores.get(key);
      scores.set(key, {
        thread: {
          ...old?.thread,
          ...thread,
          ...(old?.thread.derivedMatches || thread.derivedMatches
            ? {
                derivedMatches: combineMatches(old?.thread.derivedMatches, thread.derivedMatches),
              }
            : {}),
          ...(old?.thread.searchMatches || thread.searchMatches
            ? {
                searchMatches: combineMatches(old?.thread.searchMatches, thread.searchMatches),
              }
            : {}),
        },
        score:
          (old?.score ?? 0) +
          ((index === 0 ? mailWeight : 1) +
            ((index === 0 ? exactMail : exactAttachments).has(key) ? phraseBonus : 0)) /
            (60 + rank + 1),
      });
    }
  }
  return [...scores.values()]
    .toSorted((a, b) => b.score - a.score || b.thread.date - a.thread.date)
    .map((entry) => entry.thread);
}

/** FTS remains an independent, stronger signal than either semantic route. */
export function semanticRankFusion(
  fts: readonly ThreadSummary[],
  text: readonly ThreadSummary[],
  images: readonly ThreadSummary[],
  flat = false,
): ThreadSummary[] {
  const found = new Map<string, { thread: ThreadSummary; score: number }>();
  const lexical = new Set(fts.map((thread) => keyOf(thread, flat)));
  for (const [index, list] of [fts, text, images].entries())
    for (const [rank, thread] of list.entries()) {
      const key = keyOf(thread, flat);
      const previous = found.get(key);
      const matches = [
        ...(previous?.thread.derivedMatches ?? []),
        ...(thread.derivedMatches ?? []),
      ];
      const unique = [...new Map(matches.map((hit) => [JSON.stringify(hit), hit])).values()].slice(
        0,
        SEARCH_MATCH_LIMIT,
      );
      // A lexical hit keeps its highlighted preview; a semantic-only one is marked related.
      found.set(key, {
        thread: {
          ...previous?.thread,
          ...thread,
          ...(previous ? { snippet: previous.thread.snippet } : {}),
          ...(unique.length ? { derivedMatches: unique } : {}),
          ...(index > 0 && !lexical.has(key) ? { related: true } : {}),
        },
        score: (previous?.score ?? 0) + (index === 0 ? 2 : 1) / (60 + rank + 1),
      });
    }
  return [...found.values()]
    .toSorted((a, b) => b.score - a.score || b.thread.date - a.thread.date)
    .map((item) => item.thread);
}
