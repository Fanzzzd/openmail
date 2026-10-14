/** One fault: name, test-name pattern, file under apps/desktop, anchor text and its replacement. */
export const cases: ReadonlyArray<
  readonly [name: string, pattern: string, relative: string, before: string, after: string]
>;
/** Cases whose anchor text is no longer in its file. */
export function missingAnchors(): string[];
