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
  Proposal: "\\b(?:propos(?:als?|es?|ed|ing)|AI suggestions?)\\b",
  "AI app": "\\bAI apps?\\b",
  "Remote images": "\\bremote images?\\b",
  "AI Access": "\\bAI Access\\b",
  // A space groups accounts; disk space is a different word.
  Space: "(?<!disk )\\bspaces?\\b",
};
const patternsFor: Record<string, Partial<Record<string, string>>> = glossary;

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
        if (locale === "zh-CN" && term === "Account" && target.includes("「设置 > 账号与安全"))
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
