import { defineConfig } from "vitest/config";

// These tests read source files from the whole repo. turbo.json lists those trees as the
// inputs of @openmail/repo-checks#test, so package tests do not rerun for edits elsewhere.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
