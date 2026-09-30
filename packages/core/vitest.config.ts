import { defineConfig } from "vitest/config";
import { lowMemoryTests } from "./vitest.low-memory.js";

// Tests run from source; the build (tsconfig.build.json) leaves them out of dist.
export default defineConfig({
  test: {
    ...lowMemoryTests,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
