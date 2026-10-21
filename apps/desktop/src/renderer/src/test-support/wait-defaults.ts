/**
 * Vitest setup file for every desktop test. Besides core's scaled `vi.waitFor` default, Testing
 * Library's `waitFor` and `findBy*` queries wait `waitLimit` instead of their fixed one second.
 * Only DOM test files load Testing Library. After each test, a testDom root left mounted is
 * unmounted and fails the test.
 */
import "../../../../../../packages/core/test-support/wait-defaults.js";
import { waitLimit } from "../../../../../../packages/core/test-support/test-time.js";
import { afterEach } from "vitest";
import { disposeMountedTestDoms } from "./test-dom-leaks";

afterEach(() => {
  const left = disposeMountedTestDoms();
  if (left)
    throw new Error(
      `${left} testDom root(s) were left mounted. Call dispose() in a finally block (test-support/test-dom.ts).`,
    );
});

if (typeof document !== "undefined") {
  const { configure } = await import("@testing-library/react/pure");
  configure({ asyncUtilTimeout: waitLimit.timeout });
}
