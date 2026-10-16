import { defineConfig } from "vitest/config";
import { pollDefaults, testTimeouts } from "../core/test-support/test-time.js";

export default defineConfig({
  test: {
    ...testTimeouts,
    environment: "node",
    globalSetup: ["../core/test-support/temp-directory.ts"],
    // Scaled defaults for vi.waitFor and expect.poll. See docs/testing.md.
    setupFiles: ["../core/test-support/wait-defaults.ts"],
    expect: pollDefaults,
    include: ["src/**/*.test.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
