import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../..");
const SOURCES = ["apps/desktop/src/renderer/src", "apps/mobile/app", "apps/mobile/src"];

/**
 * Tailwind emits only class names written whole in source. An interpolation inside a utility
 * name or inside an arbitrary value, like `basis-[clamp(1rem,${n}rem)]`, `focus-within:${x}` or
 * `w-${n}`, leaves the generated CSS without the rule. Interpolating whole classes
 * (`${className}`, `${on ? "a-1" : "b-2"}`) is fine. Ids and selectors (`id-${id}`) are not
 * matched: only names that start with a Tailwind utility prefix or a variant are.
 */
const PREFIXES =
  "(?:basis|w|h|min-w|min-h|max-w|max-h|size|p[xytrbl]?|m[xytrbl]?|gap|gap-x|gap-y|inset|top|right|bottom|left|bg|text|border|ring|rounded|shadow|grid-cols|col-span|row-span|flex|z|opacity|translate-x|translate-y|rotate|scale|space-x|space-y|leading|tracking|font|fill|stroke|outline|order)";
const VARIANT =
  "(?:hover|focus|focus-within|focus-visible|active|disabled|group-[\\w-]+|peer-[\\w-]+|dark|coarse|motion-safe|motion-reduce|md|lg|sm|xl|first|last|@[\\w\\[\\]-]+(?:/[\\w-]+)?):";
const INTERPOLATED = new RegExp(
  [
    // `w-${n}`, `text-${tone}`, `-mt-${n}`
    `(?<![\\w$-])-?${PREFIXES}-\\$\\{`,
    // `focus-within:${basis}`
    `(?<![\\w$-])${VARIANT}\\$\\{`,
    // `basis-[clamp(${a},${b})]`, `w-[${n}px]`
    `(?<![\\w$-])-?${PREFIXES}-\\[[^\\]\\s\`]*\\$\\{`,
  ].join("|"),
  "g",
);

it("writes no Tailwind utility by interpolation", () => {
  const files = execFileSync("git", ["ls-files", "-z", ...SOURCES], { cwd: repo, encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.(?:ts|tsx)$/.test(file) && !/\.test\.tsx?$/.test(file));
  expect(files.length).toBeGreaterThan(100);
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(resolve(repo, file), "utf8").split("\n");
    for (const [index, line] of lines.entries())
      for (const match of line.matchAll(INTERPOLATED))
        hits.push(`${file}:${index + 1}: ${match[0]}`);
  }
  expect(hits).toEqual([]);
});

it("matches the interpolations that broke the search slot", () => {
  for (const bad of [
    "`basis-[clamp(20rem,100cqw_-_${n}rem,32.5rem)]!`",
    "`focus-within:${basis}`",
    "`w-${size}`",
    "`-mt-${n}`",
    "`bg-[${color}]`",
  ])
    expect(bad.match(INTERPOLATED), bad).not.toBeNull();
  for (const ok of [
    "`shrink-0 ${className}`",
    "`account-enabled-${id}`",
    '`${on ? "w-4" : "w-8"} flex`',
    "`openmail:panes:${mode}`",
    "`hover-${x}`",
  ])
    expect(ok.match(INTERPOLATED), ok).toBeNull();
});
