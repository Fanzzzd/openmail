import { assert, describe, it } from "@effect/vitest";

import {
  applySignature,
  fillTemplate,
  mentionsAttachment,
  ownText,
  templateVariables,
} from "./compose-text.js";

const QUOTE = "\n\n2026年9月1日，Alice <alice@x.com> 写道：\n> 请看附件\n> 谢谢";

describe("applySignature", () => {
  it("ends a new message with the signature", () => {
    assert.strictEqual(applySignature("", undefined, "王\n产品部"), "\n\n-- \n王\n产品部");
    assert.strictEqual(applySignature("你好", undefined, "王"), "你好\n\n-- \n王");
  });

  it("goes above the quote in replies, with a line to type on", () => {
    assert.strictEqual(applySignature(QUOTE, undefined, "王"), `\n\n-- \n王${QUOTE}`);
    const forward = "\n\n---------- 转发的邮件 ----------\n发件人：a@x.com";
    assert.strictEqual(applySignature(forward, undefined, "王"), `\n\n-- \n王${forward}`);
  });

  it("finds the quote in headers written in any app language", () => {
    for (const header of [
      "Am Di., 13. Okt. 2026, 10:24 schrieb Ada <ada@x.com>:",
      "2026年10月13日(火) 10:24 Ada <ada@x.com>:",
      "Le mar. 13 oct. 2026, 10:24, Ada <ada@x.com> a écrit :",
    ]) {
      const quote = `\n\n${header}\n> Hallo`;
      assert.strictEqual(applySignature(quote, undefined, "W"), `\n\n-- \nW${quote}`);
    }
    const forward = "\n\n---------- Message transféré ---------\nDe : a@x.com";
    assert.strictEqual(applySignature(forward, undefined, "W"), `\n\n-- \nW${forward}`);
    // Without quoted lines after it, an addressed line is the person's own text; so is a rule.
    assert.strictEqual(
      ownText("Write to Ada <ada@x.com>:\nthanks"),
      "Write to Ada <ada@x.com>:\nthanks",
    );
    assert.strictEqual(ownText("Notes\n--------------\nmore"), "Notes\n--------------\nmore");
  });

  it("swaps the signature when the From account changes, and removes it for none", () => {
    const withOld = applySignature(QUOTE, undefined, "旧");
    const swapped = applySignature(`收到${withOld}`, "旧", "新");
    assert.strictEqual(swapped, `收到\n\n-- \n新${QUOTE}`);
    assert.strictEqual(applySignature(swapped, "新", ""), `收到${QUOTE}`);
    assert.strictEqual(applySignature("hi\n\n-- \nA", "A", undefined), "hi");
  });

  it("leaves a signature the person edited alone", () => {
    const edited = "hi\n\n-- \nA (edited)";
    assert.strictEqual(applySignature(edited, "A", "B"), edited);
  });
});

describe("mentionsAttachment", () => {
  it("finds attachment words in the person's own text", () => {
    assert.ok(mentionsAttachment("报价单见附件。"));
    assert.ok(mentionsAttachment("Please find the file attached."));
    assert.ok(mentionsAttachment("I've enclosed the contract"));
    assert.ok(!mentionsAttachment("明天见"));
  });

  it("ignores quoted text and the signature", () => {
    assert.ok(!mentionsAttachment(`好的${QUOTE}`));
    assert.ok(!mentionsAttachment("好的\n> see attachment"));
    assert.ok(!mentionsAttachment("好的\n\n-- \n附件请发到 a@x.com"));
    assert.strictEqual(ownText(`好的\n\n-- \n王${QUOTE}`), "好的");
  });
});

describe("templates", () => {
  it("fills variables from the first recipient", () => {
    const text = "{first_name} 你好，{name} <{email}> {unknown}";
    assert.strictEqual(
      fillTemplate(text, { name: "Ada Lovelace", address: "ada@x.com" }),
      "Ada 你好，Ada Lovelace <ada@x.com> {unknown}",
    );
    assert.strictEqual(
      fillTemplate("{first_name}", { name: "王小明", address: "w@x.com" }),
      "王小明",
    );
    assert.strictEqual(
      fillTemplate("{first_name}", { name: "", address: "li.lei@x.com" }),
      "li.lei",
    );
    assert.strictEqual(fillTemplate("Hi {first_name}", undefined), "Hi ");
  });

  it("reads 'Last, First' names", () => {
    assert.deepStrictEqual(templateVariables({ name: "Lovelace, Ada", address: "a@x.com" }), {
      first_name: "Ada",
      last_name: "Lovelace",
      name: "Ada Lovelace",
      email: "a@x.com",
    });
  });
});
