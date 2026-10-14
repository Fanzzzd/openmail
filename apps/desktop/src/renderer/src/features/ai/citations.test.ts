import { expect, it } from "vitest";
import { citedParts } from "./citations";

const sources = [{ id: "gmail:a@example.com/m1" }, { id: "gmail:a@example.com/m2" }];

it("known ids become numbers; other brackets stay text", () => {
  expect(
    citedParts(
      "Done [gmail:a@example.com/m2]; both [gmail:a@example.com/m1; gmail:a@example.com/m2] [x] [gmail:a@example.com/m3]",
      sources,
    ),
  ).toEqual([
    { kind: "text", text: "Done " },
    { kind: "cite", numbers: [2] },
    { kind: "text", text: "; both " },
    { kind: "cite", numbers: [1, 2] },
    { kind: "text", text: " [x] [gmail:a@example.com/m3]" },
  ]);
});

it("text without citations comes back whole", () => {
  expect(citedParts("No sources", [])).toEqual([{ kind: "text", text: "No sources" }]);
  expect(citedParts("", sources)).toEqual([]);
});
