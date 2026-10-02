import type { Label } from "../../shared/api";

/** Immutable query arrays own their lookup maps; WeakMap releases old results. */
const maps = new WeakMap<readonly Label[], Map<string, Label>>();
export function labelsById(labels: readonly Label[]) {
  const cached = maps.get(labels);
  if (cached) return cached;
  const map = new Map(labels.map((label) => [`${label.accountId}/${label.id}`, label]));
  maps.set(labels, map);
  return map;
}
