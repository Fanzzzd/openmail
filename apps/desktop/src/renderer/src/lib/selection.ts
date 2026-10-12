import type { Prefs, ThreadSummary } from "../../../shared/api";

/** IDs remain selected when rows are reordered, virtualized or outside the loaded page. */
export interface Selection {
  ids: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
}
export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null, focus: null };
export const selectionForQuery = (selection: Selection, previous: string, current: string) =>
  previous === current ? selection : EMPTY_SELECTION;
export const singleSelection = (id: string | null): Selection =>
  id ? { ids: new Set([id]), anchor: id, focus: id } : EMPTY_SELECTION;

/** A new reply can change the representative message ID of a selected conversation. */
export function reconcileSelection(
  selection: Selection,
  previous: ReadonlyMap<string, ThreadSummary>,
  rows: readonly ThreadSummary[],
  flat: boolean,
): Selection {
  if (flat) return selection;
  const representatives = new Map(
    rows.map((row) => [JSON.stringify([row.accountId, row.threadId]), row.id]),
  );
  const resolve = (id: string | null) => {
    const before = id ? previous.get(id) : undefined;
    return before
      ? (representatives.get(JSON.stringify([before.accountId, before.threadId])) ?? id)
      : id;
  };
  const ids = [...selection.ids].map((id) => resolve(id) ?? id);
  const anchor = resolve(selection.anchor);
  const focus = resolve(selection.focus);
  return ids.every((id) => selection.ids.has(id)) &&
    anchor === selection.anchor &&
    focus === selection.focus
    ? selection
    : { ids: new Set(ids), anchor, focus };
}

export function selectRow(
  selection: Selection,
  rows: readonly string[],
  id: string,
  modifiers: { toggle?: boolean; range?: boolean } = {},
): Selection {
  if (modifiers.range) {
    const anchor = selection.anchor ?? selection.focus ?? id;
    const start = rows.indexOf(anchor);
    const end = rows.indexOf(id);
    if (start < 0 || end < 0) return { ids: new Set([...selection.ids, id]), anchor, focus: id };
    const range = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
    return {
      ids: new Set(modifiers.toggle ? [...selection.ids, ...range] : range),
      anchor,
      focus: id,
    };
  }
  if (modifiers.toggle) {
    const ids = new Set(selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    const focus = ids.has(id) ? id : ([...ids].at(-1) ?? null);
    return { ids, anchor: focus, focus };
  }
  return singleSelection(id);
}

export function selectAll(selection: Selection, rows: readonly string[]): Selection {
  if (!rows.length) return EMPTY_SELECTION;
  const loaded = new Set(rows);
  return {
    ids: loaded,
    anchor: loaded.has(selection.anchor ?? "") ? selection.anchor : (rows[0] ?? null),
    focus: loaded.has(selection.focus ?? "") ? selection.focus : (rows[0] ?? null),
  };
}

export function trimSelection(selection: Selection, visible: ReadonlySet<string>): Selection {
  const ids = new Set([...selection.ids].filter((id) => visible.has(id)));
  const first = [...ids][0] ?? null;
  const focus =
    visible.has(selection.focus ?? "") && ids.has(selection.focus ?? "") ? selection.focus : first;
  const anchor = visible.has(selection.anchor ?? "") ? selection.anchor : focus;
  return ids.size === selection.ids.size && focus === selection.focus && anchor === selection.anchor
    ? selection
    : { ids, focus, anchor };
}

/** The toolbar count, confirmation count and submitted IDs share these rows. */
export function batchScope(
  selection: Selection,
  rows: ReadonlyMap<string, ThreadSummary>,
  target?: string,
  accountId?: string,
) {
  const ids = target && !selection.ids.has(target) ? [target] : [...selection.ids];
  const selected = ids.flatMap((id) => {
    const row = rows.get(id);
    return row && (!accountId || row.accountId === accountId) ? [row] : [];
  });
  return { rows: selected, ids: selected.map((row) => row.id), count: selected.length };
}

export const requiresBatchDeleteConfirmation = (count: number) => count > 50;

export function moveSelection(
  selection: Selection,
  rows: readonly string[],
  direction: 1 | -1,
  range: boolean,
): Selection {
  const index = selection.focus === null ? -1 : rows.indexOf(selection.focus);
  const id = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + direction))];
  return id ? selectRow(selection, rows, id, { range }) : selection;
}

/** Pick outside the whole removed range; fall back at either end of the list. */
export function selectionAfterRemoval(
  selection: Selection,
  rows: readonly string[],
  removed: ReadonlySet<string>,
  preference: Prefs["nextSelection"],
  moreBelow = false,
): Selection {
  if (![...selection.ids].some((id) => removed.has(id))) return selection;
  const remaining = new Set([...selection.ids].filter((id) => !removed.has(id)));
  if (remaining.size)
    return {
      ids: remaining,
      anchor: remaining.has(selection.anchor ?? "")
        ? selection.anchor
        : ([...remaining][0] ?? null),
      focus: remaining.has(selection.focus ?? "") ? selection.focus : ([...remaining][0] ?? null),
    };
  if (preference === "none") return EMPTY_SELECTION;
  const indexes = rows.flatMap((id, index) => (removed.has(id) ? [index] : []));
  if (!indexes.length) return EMPTY_SELECTION;
  const first = indexes[0] ?? 0;
  const last = indexes.at(-1) ?? first;
  const above = rows
    .slice(0, first)
    .toReversed()
    .find((id) => !removed.has(id));
  const below = rows.slice(last + 1).find((id) => !removed.has(id));
  if (preference === "below" && !below && moreBelow) return EMPTY_SELECTION;
  return singleSelection((preference === "above" ? (above ?? below) : (below ?? above)) ?? null);
}

/**
 * A thread the route opened stays selected while its list loads; once the list
 * has loaded, a missing one is dropped and the restore is done.
 */
export function settleStartupSelection(
  startupId: string | null,
  selection: Selection,
  loaded: boolean,
  visible: ReadonlySet<string>,
) {
  if (!startupId || !loaded) return { startupId, selection };
  return { startupId: null, selection: trimSelection(selection, visible) };
}
