import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

// English is the source language in code; every other locale must be translated.
// The vite plugin compiles the .po files when the renderer imports them.
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"],
  catalogs: [
    {
      path: "<rootDir>/src/renderer/src/locales/{locale}/messages",
      include: ["<rootDir>/src/renderer/src", "<rootDir>/src/main/app/native-i18n.ts"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
