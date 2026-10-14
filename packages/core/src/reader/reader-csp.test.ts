import { assert, it } from "@effect/vitest";

import {
  PRINT_CSP,
  READER_CSP_BLOCKED,
  READER_CSP_REMOTE_IMAGES,
  READER_CSP_RESTRICTIONS,
  readerCsp,
} from "./reader-csp.js";

const directives = (policy: string) =>
  new Map(
    policy.split(";").map((part) => {
      const [name = "", ...sources] = part.trim().split(/\s+/);
      return [name, sources] as const;
    }),
  );

const POLICIES = { READER_CSP_BLOCKED, READER_CSP_REMOTE_IMAGES, PRINT_CSP };

it("blocked and print policies load nothing remote", () => {
  for (const policy of [READER_CSP_BLOCKED, PRINT_CSP]) {
    for (const [name, sources] of directives(policy))
      for (const source of sources)
        assert.notMatch(source, /^(https?:|\*|'self')|\./, `${name} allows ${source}`);
  }
  assert.deepStrictEqual(directives(PRINT_CSP).get("img-src"), ["data:"]);
});

it("no policy allows scripts and every policy carries the frame restrictions", () => {
  for (const [label, policy] of Object.entries(POLICIES)) {
    const parsed = directives(policy);
    assert.deepStrictEqual(parsed.get("default-src"), ["'none'"], label);
    assert.deepStrictEqual(parsed.get("script-src"), ["'none'"], label);
    assert.deepStrictEqual(parsed.get("style-src"), ["'unsafe-inline'"], label);
    assert.notInclude(policy, "unsafe-eval", label);
    for (const [name, sources] of directives(READER_CSP_RESTRICTIONS))
      assert.deepStrictEqual(parsed.get(name), sources, `${label} ${name}`);
  }
  for (const name of ["object-src", "frame-src", "connect-src", "base-uri", "form-action"])
    assert.deepStrictEqual(directives(READER_CSP_RESTRICTIONS).get(name), ["'none'"]);
});

it("remote images add only HTTPS images and fonts", () => {
  const blocked = directives(READER_CSP_BLOCKED);
  const remote = directives(READER_CSP_REMOTE_IMAGES);
  assert.deepStrictEqual([...remote.keys()], [...blocked.keys()]);
  for (const [name, sources] of remote) {
    const added = sources.filter((source) => !blocked.get(name)?.includes(source));
    assert.deepStrictEqual(
      added,
      name === "img-src" || name === "font-src" ? ["https:"] : [],
      name,
    );
  }
  assert.strictEqual(readerCsp(false), READER_CSP_BLOCKED);
  assert.strictEqual(readerCsp(true), READER_CSP_REMOTE_IMAGES);
});
