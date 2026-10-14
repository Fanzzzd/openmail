import { expect, it } from "vitest";
import { composeTabOrder, composeTabTarget } from "./compose-tab-order";

const natural = ["to", "subject", "signature", "ai", "mode", "bold", "body", "attach", "send"];

it("Subject goes to the body, and the controls between them follow the body", () => {
  const order = composeTabOrder(natural, "subject", "body");
  expect(order).toEqual([
    "to",
    "subject",
    "body",
    "signature",
    "ai",
    "mode",
    "bold",
    "attach",
    "send",
  ]);
  expect(composeTabTarget(order, "subject", false)).toBe("body");
  expect(composeTabTarget(order, "body", true)).toBe("subject");
  expect(composeTabTarget(order, "body", false)).toBe("signature");
  expect(composeTabTarget(order, "bold", false)).toBe("attach");
  expect(composeTabTarget(order, "attach", true)).toBe("bold");
  expect(composeTabTarget(order, "signature", true)).toBe("body");
});

it("leaves Tab to the browser outside the order and at its ends", () => {
  const order = composeTabOrder(natural, "subject", "body");
  expect(composeTabTarget(order, "menu item", false)).toBeUndefined();
  expect(composeTabTarget(order, "send", false)).toBeUndefined();
  expect(composeTabTarget(order, "to", true)).toBeUndefined();
  expect(composeTabOrder(natural, "subject", "missing")).toBe(natural);
});
