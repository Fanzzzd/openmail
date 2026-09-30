import { defineConfig } from "vitest/config";
import { lowMemoryTests } from "../../packages/core/vitest.low-memory.js";

export default defineConfig({
  test: { ...lowMemoryTests, environment: "node", include: ["src/**/*.test.ts"] },
});
