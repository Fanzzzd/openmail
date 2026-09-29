import { defineConfig } from "vitest/config";

// Tests run from source; the build (tsconfig.build.json) leaves them out of dist.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
