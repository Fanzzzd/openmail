import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// English is the source language in code; zh-CN is a translation catalog.
// The vite plugin compiles the .po files when the renderer imports them.
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN"],
  catalogs: [
    {
      path: "<rootDir>/src/renderer/src/locales/{locale}/messages",
      include: ["<rootDir>/src/renderer/src"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
