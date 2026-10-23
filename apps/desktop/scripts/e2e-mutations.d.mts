/**
 * One fault: name, the titles of the tests it must fail (as their source writes them), file under
 * apps/desktop, anchor text and its replacement.
 */
export const cases: ReadonlyArray<
  readonly [
    name: string,
    titles: readonly string[],
    relative: string,
    before: string,
    after: string,
  ]
>;
/** Cases whose anchor text is no longer in its file. */
export function missingAnchors(): string[];
/** Titles that no e2e test file writes as a test title. */
export function missingTitles(): string[];
