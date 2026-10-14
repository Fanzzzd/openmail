import { selectByteCodec } from "../bytes.js";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { originalAttachment } from "../../compose/drafts.js";
import { perfBudget } from "../../../test-support/perf-budget.js";

it("encodes a 25 MB attachment as base64 on Node", () => {
  const data = new Uint8Array(25 * 1024 * 1024).fill(0x39);
  const start = performance.now();
  const attachment = originalAttachment("large", data);
  const elapsed = performance.now() - start;
  expect(attachment.content.length).toBe(Math.ceil(data.length / 3) * 4);
  expect(attachment.content.slice(0, 8)).toBe("OTk5OTk5");
  // Wall-clock budgets only hold on an idle machine; `pnpm test:perf` enforces them.
  if (process.env.OPENMAIL_PERF === "1") expect(elapsed).toBeLessThan(perfBudget(50));
});

it("the byte codec fallback matches native encodings without a native Buffer", () => {
  const portable = selectByteCodec();
  for (const value of ["", "消息文本 📨", "lone\ud800"]) {
    const bytes = portable.from(value);
    expect(bytes.toString("base64")).toBe(Buffer.from(value).toString("base64"));
    expect(portable.byteLength(value)).toBe(Buffer.byteLength(value));
    expect(portable.from(bytes.toString("base64"), "base64").toString()).toBe(
      Buffer.from(value).toString(),
    );
  }
});
