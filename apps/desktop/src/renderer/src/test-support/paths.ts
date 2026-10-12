import { join } from "node:path";

/**
 * apps/desktop, derived from this file so tests pass from any working directory.
 * Vitest sets import.meta.dirname to the source directory in node and jsdom alike.
 */
export const desktopRoot = join(import.meta.dirname, "../../../..");
