import { defineConfig } from "vitest/config";
import config from "./vitest.config";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    environment: "jsdom",
    include: ["src/renderer/src/e2e/*.test.ts"],
    exclude: [],
    setupFiles: ["src/renderer/src/e2e/setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
