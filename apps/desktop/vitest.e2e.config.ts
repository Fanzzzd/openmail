import { defineConfig } from "vitest/config";
import config, { waitSetup } from "./vitest.config";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    environment: "jsdom",
    include: ["src/renderer/src/e2e/*.test.ts"],
    exclude: [],
    setupFiles: [...waitSetup, "src/renderer/src/e2e/setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
