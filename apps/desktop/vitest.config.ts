import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { lowMemoryTests } from "../../packages/core/vitest.low-memory.js";

export default defineConfig({
  plugins: [
    react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  test: {
    ...lowMemoryTests,
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/renderer/src/e2e/**"],
  },
});
