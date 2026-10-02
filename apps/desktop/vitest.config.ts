import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { lowMemoryTests } from "../../packages/core/vitest.low-memory.js";

export default defineConfig({
  plugins: [react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } })],
  test: { ...lowMemoryTests, environment: "node", include: ["src/**/*.test.ts"] },
});
