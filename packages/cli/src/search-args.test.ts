import { describe, expect, test } from "vitest";
import { withQueryOperands } from "./search-args.js";

describe("withQueryOperands", () => {
  test("moves search words behind --, keeping their order and the flags", () => {
    expect(
      withQueryOperands(["search", "invoice", "-newsletter", "--limit", "5", "--json"]),
    ).toEqual(["search", "--limit", "5", "--json", "--", "invoice", "-newsletter"]);
    expect(withQueryOperands(["search", "-has:attachment"])).toEqual([
      "search",
      "--",
      "-has:attachment",
    ]);
    expect(withQueryOperands(["search", "-vip"])).toEqual(["search", "--", "-vip"]);
  });

  test("keeps -h, --flag=value and words after an existing --", () => {
    expect(withQueryOperands(["search", "-h"])).toEqual(["search", "-h"]);
    expect(withQueryOperands(["search", "--cursor=abc", "x", "--", "--json"])).toEqual([
      "search",
      "--cursor=abc",
      "--",
      "x",
      "--json",
    ]);
  });

  test("finds search after global flags and leaves other commands alone", () => {
    expect(withQueryOperands(["--log-level", "debug", "search", "-x"])).toEqual([
      "--log-level",
      "debug",
      "search",
      "--",
      "-x",
    ]);
    expect(withQueryOperands(["list", "-x"])).toEqual(["list", "-x"]);
    expect(withQueryOperands(["tool", "search", "-x"])).toEqual(["tool", "search", "-x"]);
  });
});
