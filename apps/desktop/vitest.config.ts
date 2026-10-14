import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { lowMemoryTests } from "../../packages/core/vitest.low-memory.js";
import { pollDefaults } from "../../packages/core/test-support/test-time.js";

/** Scaled defaults for vi.waitFor, Testing Library and expect.poll. See docs/testing.md. */
export const waitSetup = ["src/renderer/src/test-support/wait-defaults.ts"];

export default defineConfig({
  plugins: [
    react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
    Icons({ compiler: "jsx", jsx: "react" }),
  ],
  test: {
    ...lowMemoryTests,
    environment: "node",
    globalSetup: ["../../packages/core/test-support/temp-directory.ts"],
    setupFiles: waitSetup,
    expect: pollDefaults,
    include: ["src/**/*.test.ts"],
    exclude: ["src/renderer/src/e2e/**"],
    // Load the built core natively. Transforming its dist on every file costs ~2 s per file.
    // Tests that need core mocks import core source explicitly.
    server: { deps: { external: [/packages\/core\/dist\//] } },
  },
});
