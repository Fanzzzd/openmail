/** Outlook category names are identifiers independent of casing and device locale. */
export const categoryKey = (name: string) => name.normalize("NFC").trim().toLowerCase();
export function mergeCategoryNames(
  current: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const names = new Map<string, string>();
  for (const name of current)
    if (!names.has(categoryKey(name))) names.set(categoryKey(name), name.trim());
  for (const name of remove) names.delete(categoryKey(name));
  for (const name of add)
    if (!names.has(categoryKey(name))) names.set(categoryKey(name), name.trim());
  return [...names.values()];
}
