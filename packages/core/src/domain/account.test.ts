import { describe, expect, it } from "vitest";
import { profileNameError, profileNameKey } from "./account.js";

const spaces = [
  { id: "p-work", name: "Work" },
  { id: "p-home", name: "Café" },
];

describe("profileNameKey", () => {
  it("drops format characters, folds compatibility forms and collapses blanks", () => {
    expect(profileNameKey("W­ork")).toBe(profileNameKey("Work"));
    expect(profileNameKey("ＮＯＮＥ")).toBe("none");
    expect(profileNameKey("Café")).toBe(profileNameKey("Café"));
    expect(profileNameKey("  Deep    work ")).toBe("deep work");
  });
});

describe("profileNameError", () => {
  it("refuses a name that only differs by a soft hyphen, form or letter case", () => {
    expect(profileNameError("W­ork", spaces)).toBe("taken");
    expect(profileNameError("Café", spaces)).toBe("taken");
    expect(profileNameError("ＷＯＲＫ", spaces)).toBe("taken");
  });

  it("refuses none in any disguise", () => {
    expect(profileNameError("no­ne", spaces)).toBe("reserved");
    expect(profileNameError("ＮＯＮＥ", spaces)).toBe("reserved");
  });

  it("refuses control characters such as a line break inside a name as control, not empty", () => {
    expect(profileNameError("a\nb", spaces)).toBe("control");
    expect(profileNameError("a\tb", spaces)).toBe("control");
    expect(profileNameError("a\u0007b", spaces)).toBe("control");
    expect(profileNameError("\t\n", spaces)).toBe("empty");
    expect(profileNameError("a b", spaces)).toBeUndefined();
  });

  it("refuses another space's id as a name as id, not taken, but a space may keep its own", () => {
    expect(profileNameError("p-home", spaces)).toBe("id");
    expect(profileNameError("P-HOME", spaces)).toBe("id");
    expect(profileNameError("p-home", spaces, "p-home")).toBeUndefined();
    expect(profileNameError("Work", spaces, "p-work")).toBeUndefined();
  });
});
