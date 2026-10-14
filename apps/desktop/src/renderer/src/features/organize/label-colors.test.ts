import { expect, it } from "vitest";
import { CUSTOM_COLOR, LABEL_COLORS, labelColorName } from "./label-colors";

const name = (color: string) => labelColorName(color).message;

it("names each offered color, a nearby color by its closest name, and anything else Custom color", () => {
  for (const color of LABEL_COLORS) expect(labelColorName(color.value)).toBe(color.name);
  expect(name("#a479e2")).toBe("Purple");
  expect(name("#4a86e8")).toBe("Blue");
  expect(name("#16A766")).toBe("Green");
  expect(name("#f691b2")).toBe("Pink");
  expect(name("#0b1d3a")).toBe(CUSTOM_COLOR.message);
  expect(name("not a color")).toBe(CUSTOM_COLOR.message);
});
