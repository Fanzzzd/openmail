import { readFile } from "node:fs/promises";
import { formatter } from "@lingui/format-po";
import { expect, it } from "vitest";

// "Не удалось синхронизировать (2)" ran to 3 lines in the narrow sidebar and clipped behind the
// Settings icon. The status label is short in Russian and wraps inside its own box.
it("the ru sync-failed status label is the short noun phrase", async () => {
  const file = new URL("../../locales/ru/messages.po", import.meta.url);
  const catalog = await formatter().parse(await readFile(file, "utf8"), {
    locale: "ru",
    sourceLocale: "en",
    filename: file.pathname,
  });
  const label = Object.values(catalog).find((entry) => entry.message === "Sync failed ({count})");
  expect(label?.translation).toBe("Ошибка синхронизации ({count})");
});

it("the footer status label can shrink and wrap instead of running under the icons", async () => {
  const source = await readFile(new URL("./SidebarFooter.tsx", import.meta.url), "utf8");
  expect(source).toMatch(/<Popover\.Trigger className="min-w-0 [^"]*\bbreak-words\b/);
  expect(source).toMatch(/<span className="break-words">\{syncStatus\(\)\}<\/span>/);
});
