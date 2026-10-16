import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { expect, it } from "vitest";
import { searchSlotClass } from "./search-slot";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(`${here}/search-slot.ts`, "utf8");
const require = createRequire(import.meta.url);

/** The candidates Tailwind's scanner takes from source: runs of non-space, non-quote text. */
const candidates = new Set(source.split(/[\s"'`]+/).filter(Boolean));

/** Every class the slot can return, from the file's own inputs. */
function everyClass(): string[] {
  const out = new Set<string>();
  for (const toolbar of [true, false])
    for (const query of ["", "from:nora"])
      for (const selected of [true, false])
        for (const name of searchSlotClass(toolbar, query, selected).split(" ")) out.add(name);
  return [...out];
}

// Tailwind emits only class names written whole in source. The slot once built
// `basis-[clamp(...${n}rem...)]!` and `focus-within:${basis}` by interpolation, so the built CSS
// lacked the 40rem rule and every focus-within rule, and the field never grew.
it("writes every class the search slot returns as a literal Tailwind finds in the source", () => {
  for (const name of everyClass()) expect(candidates.has(name), name).toBe(true);
});

it("builds a CSS rule for every class the search slot returns", async () => {
  const compiler = await compile('@import "tailwindcss/utilities";', {
    base: here,
    loadStylesheet: async (id, base) => {
      const path =
        id === "tailwindcss/utilities" ? require.resolve("tailwindcss/utilities.css") : id;
      return { path, base, content: readFileSync(path, "utf8") };
    },
  });
  const css = compiler.build([...candidates]);
  const rules = [
    "basis-\\[clamp\\(20rem\\,100cqw_-_40rem\\,32\\.5rem\\)\\]\\!",
    "basis-\\[clamp\\(20rem\\,100cqw_-_8rem\\,32\\.5rem\\)\\]\\!",
  ];
  for (const rule of rules) {
    expect(css).toContain(`.${rule}`);
    expect(css).toContain(`.focus-within\\:${rule}`);
  }
});
