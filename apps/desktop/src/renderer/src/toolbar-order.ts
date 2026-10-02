import type { ToolbarAction } from "@openmail/core/schema";

export function moveToolbarAction(
  actions: readonly ToolbarAction[],
  action: ToolbarAction,
  direction: -1 | 1,
): ToolbarAction[] {
  const result = [...new Set(actions)];
  const index = result.indexOf(action),
    target = index + direction;
  if (index >= 0 && target >= 0 && target < result.length) {
    const other = result[target];
    if (other) {
      result[target] = action;
      result[index] = other;
    }
  }
  return result;
}
