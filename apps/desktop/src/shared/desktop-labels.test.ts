import { expect, it } from "vitest";
import { pluralTemplates, pluralText } from "./desktop-labels";

// What a compiled ICU plural message returns for each count, per locale.
const ru = (n: number) =>
  `${n} ${n % 10 === 1 && n % 100 !== 11 ? "новое сообщение" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "новых сообщения" : "новых сообщений"}`;
const ja = (n: number) => `新着メッセージ ${n} 件`;

it("builds one digest template per plural category and picks the right form for any count", () => {
  // Russian "other" is only for fractions, so whole counts never need it.
  const templates = pluralTemplates("ru", ru, String);
  expect(templates).toEqual({
    one: "# новое сообщение",
    few: "# новых сообщения",
    many: "# новых сообщений",
  });
  expect(pluralText("ru", templates, 21)).toBe("21 новое сообщение");
  expect(pluralText("ru", templates, 3)).toBe("3 новых сообщения");
  expect(pluralText("ru", templates, 6)).toBe("6 новых сообщений");
  // Czech "many" is only for fractions, so whole counts use one, few and other.
  const cs = pluralTemplates(
    "cs",
    (n) => `${n} ${n === 1 ? "nová zpráva" : n >= 2 && n <= 4 ? "nové zprávy" : "nových zpráv"}`,
    String,
  );
  expect(pluralText("cs", cs, 1)).toBe("1 nová zpráva");
  expect(pluralText("cs", cs, 4)).toBe("4 nové zprávy");
  expect(pluralText("cs", cs, 12)).toBe("12 nových zpráv");
  // Word order comes from the message, so the count can sit mid-sentence.
  expect(pluralText("ja", pluralTemplates("ja", ja, String), 7)).toBe("新着メッセージ 7 件");
  expect(pluralText("en", { one: "# new message", other: "# new messages" }, 1_200)).toBe(
    "1,200 new messages",
  );
});
