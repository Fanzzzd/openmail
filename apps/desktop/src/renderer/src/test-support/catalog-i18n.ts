import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createCompiledCatalog } from "@lingui/cli/api";
import { formatter } from "@lingui/format-po";
import { setupI18n, type I18n, type Messages } from "@lingui/core";

/** An I18n with the real compiled catalog of `locale`, and the parsed catalog it came from. */
export async function catalogI18n(locale: string) {
  const file = new URL(`../locales/${locale}/messages.po`, import.meta.url);
  const catalog = await formatter().parse(await readFile(file, "utf8"), {
    locale,
    sourceLocale: "en",
    filename: fileURLToPath(file),
  });
  const compiled = createCompiledCatalog(
    locale,
    Object.fromEntries(
      Object.entries(catalog).map(([id, message]) => [id, message.translation ?? ""]),
    ),
    { namespace: "cjs", strict: true },
  );
  if (compiled.errors.length > 0)
    throw new Error(`${locale} catalog does not compile: ${JSON.stringify(compiled.errors)}`);
  const module: { exports: { messages: Messages } } = { exports: { messages: {} } };
  runInNewContext(compiled.source, { module });
  const i18n: I18n = setupI18n({ locale, messages: { [locale]: module.exports.messages } });
  return { i18n, catalog };
}
