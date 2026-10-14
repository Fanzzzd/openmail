import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";
import { createCompiledCatalog } from "@lingui/cli/api";
import { setupI18n, type Messages } from "@lingui/core";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import glossary from "../locales/glossary.json";

const selectors: Record<string, string> = {
  Archive: "\\barchiv(?:e|ed|ing)\\b",
  Draft: "\\bdrafts?\\b",
  Reply: "\\brepl(?:y|ies)\\b",
  Forward: "\\bforward(?:ed|ing)?\\b",
  Snooze: "\\bsnooz(?:e|ed|ing)\\b",
  Conversation: "\\b(?:threads?|conversations?)\\b",
  "AI suggestion": "\\b(?:propos(?:als?|es?|ed|ing)|AI suggestions?)\\b",
  // Server filters. Quick filters are their own term, and "Filter shortcuts" is a verb.
  Filter: "(?<!quick )\\b(?:server )?filters?\\b(?! shortcuts)",
  "Quick filters": "\\bquick filters?\\b",
  "AI app": "\\bAI apps?\\b",
  "Remote images": "\\bremote images?\\b",
  "AI Access": "\\bAI Access\\b",
  // A space groups accounts; disk space is a different word.
  Space: "(?<!disk )\\bspaces?\\b",
};
const patternsFor: Record<string, Partial<Record<string, string>>> = glossary;
const word = (words: string, flags = "u") => new RegExp(`(?<!\\p{L})(?:${words})(?!\\p{L})`, flags);
// Usted forms: the pronoun, usted imperatives, and su/sus/le where they address the reader.
const spanishUsted = [
  word("usted|ustedes", "iu"),
  word(
    "Elija|Haga|Pulse|Presione|presione|Introduzca|Ingrese|Vuelva|Compruebe|Verifique|Añada|Agregue|Abra|Asegúrese|asegúrese|Espere|Intente|Inténtelo|inténtelo|Seleccione|Inicie|Conecte|Instale|Revise|Guarde|Utilice|Autorice|Termine|Deje|Elimine|Restaure|Suelte|Adjunte|Asigne|Salga|Responda|Cambie|Limite|Puede cerrar|Puede deshacer|Inició sesión",
  ),
  word(
    "(?:su|sus) (?:navegador|conexión|credenciales|cuentas|primera cuenta|calendario principal|hora local|consentimiento|propio cliente|información|contraseña web|cuenta de Google|cuenta personal|cuenta de Yahoo|cuenta Apple|cambios)|[Ss]e le pedirá|le pedirá",
  ),
];
// Formal German: Sie, Ihnen and Ihr- anywhere but a sentence start, where "Sie" means "it"
// or "she" ("Sie läuft …"). That catches imperatives such as "Stellen Sie …" and "Ihre Adresse".
const germanSie = /(?<!(?:^|[.!?:]\s+|[„“"«(]))(?<!\p{L})(?:Sie|Ihnen|Ihre?[mnrs]?)(?!\p{L})/u;
// Quote marks that are not the locale's own style. Chinese and Japanese are checked below with
// their settings paths. German and Czech quote „…“, Dutch and Italian “…”, French, Spanish and
// Russian «…»; French, Italian and Dutch use ’ as the apostrophe.
const foreignQuotes: Partial<Record<string, RegExp>> = {
  cs: /[”«»‘’「」]/u,
  de: /[”«»‘’「」]/u,
  nl: /[„‚‘«»「」]/u,
  it: /[„‚‘«»「」]/u,
  fr: /[“”„‚‘「」]/u,
  es: /[“”„‚‘’「」]/u,
  ru: /[“”„‚‘’「」]/u,
};
// Informal Russian: ты and its forms, and imperatives without -те.
const russianInformal = [
  word("ты|тебя|тебе|тобой|тво(?:й|я|ё|е|и|его|ему|ей|ю|им|их|ими)", "iu"),
  word(
    "Спроси|Спрашивай|Нажми|Выбери|Открой|Добавь|Проверь|Попробуй|Включи|Отключи|Введи|Подожди|Удали|Сохрани|Используй|Перейди|Вернись|Закрой|Убедись|Скопируй|Создай|Войди|Подключи|Разреши|Обнови|Укажи|Измени|Подтверди|Настрой|Отмени|Повтори",
    "iu",
  ),
];

it("the complete catalogs consistently use the mail glossary, message-text terminology and the actual Edit body label", async () => {
  const po = formatter();
  const failures: string[] = [];
  for (const locale of ["zh-CN", "cs", "nl", "fr", "de", "it", "ja", "ru", "es"] as const) {
    const file = new URL(`../locales/${locale}/messages.po`, import.meta.url);
    const catalog = await po.parse(await readFile(file, "utf8"), {
      locale,
      sourceLocale: "en",
      filename: fileURLToPath(file),
    });
    for (const message of Object.values(catalog)) {
      const source = message.message ?? "";
      const target = message.translation ?? "";
      const visibleSource = source.replace(/\{[A-Za-z_]\w*\}/g, "");
      for (const [term, patterns] of Object.entries(patternsFor)) {
        // Terms without a pattern for this locale are not checked there (zh-CN has few).
        const pattern = patterns[locale];
        if (pattern === undefined) continue;
        // Other is an Outlook tab only in its context or in explicit classification text.
        if (
          term === "Other" &&
          message.context !== "outlook-inbox" &&
          !/Focused\/Other|(?:to|in|Outlook) Other/.test(source)
        )
          continue;
        // Japanese naturally calls the message text 本文, without repeating メッセージ.
        if (locale === "ja" && source === "Message body" && term === "Message") continue;
        // QQ Mail's own settings menu is named 账号与安全; the path quotes it verbatim.
        if (locale === "zh-CN" && term === "Account" && target.includes("“设置 → 账号与安全"))
          continue;
        const selector = new RegExp(selectors[term] ?? `\\b${term}s?\\b`, "i");
        if (selector.test(visibleSource) && !new RegExp(pattern, "iu").test(target))
          failures.push(`${locale}: ${term}: ${source} → ${target}`);
      }
      // The UI calls an account group a space; "profile" is only the code name.
      if (/\bprofiles?\b/i.test(source) || /\bprofil|プロファイル|профил|werkruimte/iu.test(target))
        failures.push(`${locale}: Space: ${source} → ${target}`);
      if (/\b(?:body|bodies)\b/i.test(source))
        expect(target, `${locale}: ${source}`).not.toMatch(
          /Leichen|Körper|corps|тела|тело|těla|tělo|遺体|身体|lichaam|\bcorpo\b|\bcuerpo\b/i,
        );
      if (
        locale === "de" &&
        source.length < 90 &&
        !source.endsWith(".") &&
        /^(?:Add|Always|Apply|Ask|Attach|Authorize|Choose|Close|Confirm|Connect|Continue|Create|Describe|Download|Drag|Enable|Enter|Expand|Find|Finish|Group|Join|Load|Make|Modify|Move|Open|Pause|Replace|Reply|Resume|Search|Select|Sign|Stop|Use)\b/.test(
          source,
        )
      )
        expect(target, source).not.toMatch(/\bSie\b/);
      // Japanese says 読み込み (not ロード) and メール (not 電子メール), puts no space after 。,
      // and puts a space between a Latin word and Japanese text, as in AI アプリ.
      if (
        locale === "ja" &&
        (/(?<!ダウン|アップ)ロード|電子メール|。 /u.test(target) ||
          /[A-Za-z][\u3040-\u30FB\u30FD-\u30FF\u4E00-\u9FFF]|[\u3040-\u30FB\u30FD-\u30FF\u4E00-\u9FFF][A-Za-z]/u.test(
            target,
          ))
      )
        failures.push(`${locale}: style: ${source} → ${target}`);
      // UI names and settings paths are quoted the local way: “” (nested ‘’) in Chinese,
      // 「」 (nested 『』) in Japanese. A settings path is always quoted.
      if (locale === "zh-CN" && (/[「」『』]/u.test(target) || /(?<![“‘])设置 →/u.test(target)))
        failures.push(`${locale}: quotes: ${source} → ${target}`);
      if (locale === "ja" && (/[“”‘’]/u.test(target) || /(?<![「『])設定 →/u.test(target)))
        failures.push(`${locale}: quotes: ${source} → ${target}`);
      // Text never uses ASCII quotes or apostrophes: placeholders, ICU syntax and component tags
      // hold none, and a lone ' is ICU's escape character.
      if (/["']/.test(target)) failures.push(`${locale}: ASCII quote: ${source} → ${target}`);
      if (
        foreignQuotes[locale]?.test(target) ||
        ((locale === "de" || locale === "cs") &&
          target.split("„").length !== target.split("“").length) ||
        (locale === "fr" && /«(?![\s\u00A0\u202F])|(?<![\s\u00A0\u202F])»/u.test(target)) ||
        ((locale === "es" || locale === "ru" || locale === "it") && /«\s|\s»|“\s|\s”/u.test(target))
      )
        failures.push(`${locale}: quotes: ${source} → ${target}`);
      // An empty displayed value (no Cc, no location) is 无; 不选 is only a picker option.
      if (locale === "zh-CN" && message.context === "empty value" && target !== "无")
        failures.push(`${locale}: empty value: ${source} → ${target}`);
      // "Authorize permission" is not a doubled verb in French.
      if (locale === "fr" && /autoris\p{L}* l[’']autorisation/iu.test(target))
        failures.push(`${locale}: style: ${source} → ${target}`);
      // Spanish addresses the reader with tú, German with du, Dutch with je and Russian with вы.
      if (locale === "es" && spanishUsted.some((pattern) => pattern.test(target)))
        failures.push(`${locale}: register: ${source} → ${target}`);
      if (locale === "de" && germanSie.test(target))
        failures.push(`${locale}: register: ${source} → ${target}`);
      if (locale === "nl" && /(?<!\p{L})(?:u|uw|uzelf)(?!\p{L})/iu.test(target))
        failures.push(`${locale}: register: ${source} → ${target}`);
      if (locale === "ru" && russianInformal.some((pattern) => pattern.test(target)))
        failures.push(`${locale}: register: ${source} → ${target}`);
      if (locale === "es" && /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/.test(target))
        expect(target[0], source).toBe(target[0]?.toUpperCase());
    }
    const label = Object.entries(catalog).find(
      ([, message]) => message.message === "Edit body" && message.context === "message text action",
    );
    expect(label).toBeDefined();
    const compiled = createCompiledCatalog(
      locale,
      Object.fromEntries(
        Object.entries(catalog).map(([id, message]) => [id, message.translation ?? ""]),
      ),
      { namespace: "cjs", strict: true },
    );
    expect(compiled.errors).toEqual([]);
    const module: { exports: { messages: Messages } } = { exports: { messages: {} } };
    runInNewContext(compiled.source, { module });
    const i18n = setupI18n({ locale, messages: { [locale]: module.exports.messages } });
    const editBody = i18n._(label?.[0] ?? "");
    const instructions = Object.entries(catalog).filter(([, message]) =>
      message.message?.startsWith("Choose {editBody} before"),
    );
    expect(instructions).toHaveLength(2);
    for (const [id] of instructions) expect(i18n._(id, { editBody })).toContain(editBody);
    if (locale === "it")
      expect(
        Object.values(catalog).find((message) => message.message === "Discard")?.translation,
      ).toBe("Scarta");
  }
  expect(failures).toEqual([]);
});
