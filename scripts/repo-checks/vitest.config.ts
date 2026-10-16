import { defineConfig } from "vitest/config";
import { testTimeouts } from "../../packages/core/test-support/test-time.js";

// These tests read source files from the whole repo. turbo.json lists those trees as the
// inputs of @openmail/repo-checks#test, so package tests do not rerun for edits elsewhere.
export default defineConfig({
  test: {
    ...testTimeouts,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
