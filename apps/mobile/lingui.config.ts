import { defineConfig } from "@lingui/cli";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["<rootDir>/app", "<rootDir>/src"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
