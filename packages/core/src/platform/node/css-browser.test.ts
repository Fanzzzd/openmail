import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { parse, generate, walk } from "css-tree/dist/csstree.esm";

it("portable CSS uses the browser ESM export without Node builtins under Metro's resolver", () => {
  const require = createRequire(import.meta.url);
  const path = require.resolve("css-tree/package.json");
  const manifest = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        exports: Schema.Struct({ "./dist/*": Schema.String }),
        browser: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  )(readFileSync(path, "utf8"));
  expect(manifest.exports["./dist/*"]).toBe("./dist/*.js");
  expect(manifest.browser["./lib/data.js"]).toBe("./dist/data.js");
  const bundle = readFileSync(join(dirname(path), "dist/csstree.esm.js"), "utf8");
  expect(/\bcreateRequire\b|\bprocess\./.test(bundle)).toBe(false);
  const portable = readFileSync(
    new URL("../../reader/css-tree-browser.ts", import.meta.url),
    "utf8",
  );
  expect(portable).toContain('from "css-tree/dist/csstree.esm"');
  const metro = readFileSync(
    new URL("../../../../../apps/mobile/metro.config.cjs", import.meta.url),
    "utf8",
  );
  expect(metro).toContain('require("expo/metro-config")');
  expect(metro).toContain("context.resolveRequest(context, moduleName, platform)");
  const ast = parse('p{background:url("https://example.test/x");color:red}');
  walk(ast, (node) => {
    if (node.type === "Url") node.value = "data:,";
  });
  expect(generate(ast)).toBe("p{background:url(data:,);color:red}");
});
