import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { createCompiledCatalog } from "@lingui/cli/api";
import { formatter } from "@lingui/format-po";
import { setupI18n, type Messages } from "@lingui/core";
import { expect, it } from "vitest";
import { parse, type Token } from "@messageformat/parser";

/** Derive sample bindings from ICU instead of maintaining a list of feature-specific names. */
function sampleArguments(tokens: readonly Token[], count: number): Record<string, string | number> {
  const names = new Set<string>(),
    numbers = new Set<string>();
  const visit = (items: readonly Token[]) => {
    for (const token of items) {
      if ("arg" in token) names.add(token.arg);
      if (token.type === "plural" || token.type === "selectordinal") numbers.add(token.arg);
      if ("cases" in token) for (const branch of token.cases) visit(branch.tokens);
    }
  };
  visit(tokens);
  return Object.fromEntries([...names].map((name) => [name, numbers.has(name) ? count : "VALUE"]));
}

it("all real catalogs compile and render ICU counts, arguments and component markup", async () => {
  const po = formatter();
  const root = new URL("../locales/", import.meta.url);
  const source = await po.parse(readFileSync(new URL("en/messages.po", root), "utf8"), {
    locale: "en",
    sourceLocale: "en",
    filename: fileURLToPath(new URL("en/messages.po", root)),
  });
  for (const locale of ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"]) {
    const catalog = await po.parse(readFileSync(new URL(`${locale}/messages.po`, root), "utf8"), {
      locale,
      sourceLocale: "en",
      filename: fileURLToPath(new URL(`${locale}/messages.po`, root)),
    });
    const compiled = createCompiledCatalog(
      locale,
      Object.fromEntries(
        Object.entries(catalog).map(([id, message]) => [id, message.translation ?? ""]),
      ),
      { namespace: "cjs", strict: true },
    );
    expect(compiled.errors).toEqual([]);
    for (const message of Object.values(catalog)) {
      const tokens = parse(message.translation ?? "", { strict: true });
      if (locale === "ja") {
        const checkCases = (items: Token[]) => {
          for (const token of items)
            if (
              token.type === "plural" ||
              token.type === "select" ||
              token.type === "selectordinal"
            ) {
              if (token.type === "plural")
                expect(token.cases.some((item) => item.key === "one")).toBe(false);
              for (const item of token.cases) checkCases(item.tokens);
            }
        };
        checkCases(tokens);
      }
    }
    const module: { exports: { messages: Messages } } = { exports: { messages: {} } };
    runInNewContext(compiled.source, { module });
    const i18n = setupI18n({ locale, messages: { [locale]: module.exports.messages } });
    for (const [id, message] of Object.entries(source)) {
      if (!message.message?.includes(", plural,")) continue;
      for (const count of [0, 1, 2, 5, 21, 1.5]) {
        const rendered = i18n._(
          id,
          sampleArguments(parse(message.message, { strict: true }), count),
        );
        expect(rendered).not.toContain("plural");
        expect(rendered).not.toContain("{");
        expect(rendered).toContain(i18n.number(count));
      }
    }
    const attachmentSource = Object.entries(source).find(
      ([, message]) => message.message === "In attachment {attachmentName}:",
    );
    expect(attachmentSource).toBeDefined();
    const attachmentLabel = i18n._(attachmentSource?.[0] ?? "", { attachmentName: "invoice.pdf" });
    expect(attachmentLabel).toContain("invoice.pdf");
    expect(attachmentLabel).not.toContain("{");
    expect(attachmentLabel.endsWith(locale === "zh-CN" || locale === "ja" ? "：" : ":")).toBe(true);
    const markup = Object.entries(source).find(
      ([, message]) => message.message === "This space has no accounts yet. <0>Add account</0>",
    );
    expect(markup).toBeDefined();
    expect(i18n._(markup?.[0] ?? "")).toMatch(/<0>.+<\/0>/);
    const seconds = Object.entries(source).find(
      ([, message]) => message.message === "{seconds, plural, one {# second} other {# seconds}}",
    );
    if (locale === "cs") expect(i18n._(seconds?.[0] ?? "", { seconds: 5 })).toBe("5 sekund");
    if (locale === "ru") expect(i18n._(seconds?.[0] ?? "", { seconds: 21 })).toBe("21 секунда");
  }
});

it("the translation check lists raw missing, fuzzy and broken arguments in every locale and exits nonzero", () => {
  const root = mkdtempSync(join(tmpdir(), "openmail-catalogs-"));
  const locales = ["en", "zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"];
  const header = 'msgid ""\nmsgstr ""\n"Content-Type: text/plain; charset=UTF-8\\n"\n\n';
  try {
    for (const locale of locales) {
      mkdirSync(join(root, locale));
      writeFileSync(
        join(root, locale, "messages.po"),
        `${header}msgid "Hello {name}"\nmsgstr "Salut {name}"\n`,
      );
    }
    const script = fileURLToPath(new URL("../../../../scripts/i18n-missing.mjs", import.meta.url));
    const run = () => spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(run().status).toBe(0);
    for (const locale of locales.filter((locale) => locale !== "en")) {
      writeFileSync(
        join(root, locale, "messages.po"),
        `${header}msgid "Hello {name}"\nmsgstr ""\n`,
      );
    }
    let result = run();
    expect(result.status).toBe(1);
    for (const locale of locales.filter((locale) => locale !== "en")) {
      expect(result.stdout).toContain(`${locale}: 1 missing`);
    }
    writeFileSync(
      join(root, "ja", "messages.po"),
      `${header}msgid "Hello {name}"\nmsgstr "こんにちは {wrong}"\n`,
    );
    writeFileSync(
      join(root, "ru", "messages.po"),
      `${header}#, fuzzy\nmsgid "Hello {name}"\nmsgstr "Привет {name}"\n`,
    );
    result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("ICU arguments or markup differ");
    expect(result.stdout).toContain('missing msgstr: "Hello {name}"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("Chinese incoming action flag labels have a separate noun context", async () => {
  const url = new URL("../locales/zh-CN/messages.po", import.meta.url);
  const catalog = await formatter().parse(readFileSync(url, "utf8"), {
    locale: "zh-CN",
    sourceLocale: "en",
    filename: fileURLToPath(url),
  });
  const contextual = Object.values(catalog).filter(
    (message) => message.context === "incoming message action flag",
  );
  expect(
    Object.fromEntries(contextual.map((message) => [message.message, message.translation])),
  ).toEqual({
    Forward: "转发标记",
    Read: "阅读标记",
    Reply: "回复标记",
    "Reply all": "全部回复标记",
  });
});

it("the English catalog only mirrors its source text", async () => {
  // English is the source locale: a msgstr that differs from its msgid would show
  // text nobody wrote in the code, such as "Confirm Remove" for "Confirm removal".
  const url = new URL("../locales/en/messages.po", import.meta.url);
  const catalog = await formatter().parse(readFileSync(url, "utf8"), {
    locale: "en",
    sourceLocale: "en",
    filename: fileURLToPath(url),
  });
  const differing = Object.entries(catalog)
    .map(([id, entry]) => ({ source: entry.message ?? id, translation: entry.translation ?? "" }))
    .filter(({ source, translation }) => translation !== "" && translation !== source);
  expect(differing).toEqual([]);
});
