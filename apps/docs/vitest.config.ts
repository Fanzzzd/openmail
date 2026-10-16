import { defineConfig } from "vitest/config";
import { testTimeouts } from "../../packages/core/test-support/test-time.js";

// Scaled per-test and hook timeouts, as in every other package. See docs/testing.md.
export default defineConfig({ test: { ...testTimeouts } });
