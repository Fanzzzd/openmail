/**
 * Vitest setup file for every desktop test. Besides core's scaled `vi.waitFor` default, Testing
 * Library's `waitFor` and `findBy*` queries wait `waitLimit` instead of their fixed one second.
 * Only DOM test files load Testing Library.
 */
import "../../../../../../packages/core/test-support/wait-defaults.js";
import { waitLimit } from "../../../../../../packages/core/test-support/test-time.js";

if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react/pure");
  configure({ asyncUtilTimeout: waitLimit.timeout });
}
