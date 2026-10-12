import type { Prefs, ThreadSummary } from "../../../shared/api";

/** IDs remain selected when rows are reordered, virtualized or outside the loaded page. */
export interface Selection {
  ids: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
  /**
   * Gmail's X started checking rows. J and K then move only the cursor, even while one
   * row, or none, is checked. Opening or clicking a row ends it.
   */
  checking: boolean;
  /** Rows checked before a Shift range started from X checking. The range adds to them. */
  kept?: ReadonlySet<string>;
}
export const EMPTY_SELECTION: Selection = {
  ids: new Set(),
  anchor: null,
  focus: null,
  checking: false,
};
export const selectionForQuery = (selection: Selection, previous: string, current: string) =>
  previous === current ? selection : EMPTY_SELECTION;
export const singleSelection = (id: string | null): Selection =>
  id ? { ids: new Set([id]), anchor: id, focus: id, checking: false } : EMPTY_SELECTION;

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
    : { ...selection, ids: new Set(ids), anchor, focus };
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
    // A range started from X checking keeps the checked rows, also while it grows or shrinks.
    const kept = selection.checking ? selection.ids : selection.kept;
    if (start < 0 || end < 0)
      return { ids: new Set([...selection.ids, id]), anchor, focus: id, checking: false, kept };
    const range = rows.slice(Math.min(start, end), Math.max(start, end) + 1);
    const base = modifiers.toggle ? selection.ids : (kept ?? []);
    return { ids: new Set([...base, ...range]), anchor, focus: id, checking: false, kept };
  }
  if (modifiers.toggle) {
    const ids = new Set(selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    const focus = ids.has(id) ? id : ([...ids].at(-1) ?? null);
    return { ids, anchor: focus, focus, checking: false };
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
    checking: selection.checking,
  };
}

export function trimSelection(selection: Selection, visible: ReadonlySet<string>): Selection {
  const ids = new Set([...selection.ids].filter((id) => visible.has(id)));
  const first = [...ids][0] ?? null;
  // A cursor on an unselected row (Gmail's X and J/K) stays while that row is visible.
  const focus = visible.has(selection.focus ?? "") ? selection.focus : first;
  const anchor = visible.has(selection.anchor ?? "") ? selection.anchor : focus;
  return ids.size === selection.ids.size && focus === selection.focus && anchor === selection.anchor
    ? selection
    : { ...selection, ids, focus, anchor };
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

/**
 * Gmail's X: check or uncheck the row under the cursor. The cursor stays on that row.
 * X on the one open row starts checking and keeps that row checked.
 */
export function toggleFocused(selection: Selection): Selection {
  const id = selection.focus;
  if (id === null) return selection;
  const ids = new Set(selection.ids);
  const opened = !selection.checking && ids.size === 1 && ids.has(id);
  if (opened) return { ids, anchor: id, focus: id, checking: true };
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id, focus: id, checking: true };
}

/** Gmail's J/K while rows are checked: move the cursor and keep the selection. */
export function moveCursor(
  selection: Selection,
  rows: readonly string[],
  direction: 1 | -1,
): Selection {
  const index = selection.focus === null ? -1 : rows.indexOf(selection.focus);
  const id = rows[Math.max(0, Math.min(rows.length - 1, index < 0 ? 0 : index + direction))];
  return id ? { ids: selection.ids, anchor: id, focus: id, checking: true } : selection;
}

/** Whether J/K should move only the cursor: X started checking, or several rows are selected. */
export const checkingRows = (selection: Selection) => selection.checking || selection.ids.size > 1;

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
      checking: selection.checking,
    };
  if (preference === "none") return EMPTY_SELECTION;
  // In X checking the cursor is the open row once the checked rows are gone.
  const { focus } = selection;
  if (selection.checking && focus !== null && !removed.has(focus) && rows.includes(focus))
    return singleSelection(focus);
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
