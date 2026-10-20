import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../..");

/**
 * Han, kana, Hangul, CJK punctuation (`。`, `「`) and fullwidth forms (`，`, `（`).
 */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/**
 * Docs are written in English. These files are translations or locale data by design.
 */
const ALLOWED_FILE = /^README\.zh-CN\.md$|(?:^|\/)(?:locales?|i18n)\//;

/**
 * A line may keep CJK when the CJK is the subject matter: a glossary term, a quoted
 * translated UI string, CJK test data. Mark such a line with `<!-- cjk-ok -->` at its end.
 * Where a trailing comment would change the content (a table row, a code block), put
 * `<!-- cjk-ok:start -->` and `<!-- cjk-ok:end -->` on their own lines around the block.
 */
const LINE_MARKER = "<!-- cjk-ok -->";
const BLOCK_START = "<!-- cjk-ok:start -->";
const BLOCK_END = "<!-- cjk-ok:end -->";

function cjkLines(text: string): number[] {
  const hits: number[] = [];
  // Line number of the open block's start marker, or 0 outside a block.
  let blockStart = 0;
  for (const [index, line] of text.split("\n").entries()) {
    const marker = line.trim();
    if (marker === BLOCK_START || marker === BLOCK_END) {
      blockStart = marker === BLOCK_START ? index + 1 : 0;
      continue;
    }
    if (!blockStart && !line.includes(LINE_MARKER) && CJK.test(line)) hits.push(index + 1);
  }
  // A start marker without an end would exempt the rest of the file: report the marker.
  if (blockStart) hits.push(blockStart);
  return hits;
}

it("keeps tracked Markdown in English", () => {
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.md", "*.mdx"], {
    cwd: repo,
    encoding: "utf8",
  })
    .split("\0")
    // CLAUDE.md is a symlink to AGENTS.md; read each file once.
    .filter(
      (file) =>
        file && !ALLOWED_FILE.test(file) && !lstatSync(resolve(repo, file)).isSymbolicLink(),
    );
  expect(files.length).toBeGreaterThan(20);
  const hits: string[] = [];
  for (const file of files)
    for (const line of cjkLines(readFileSync(resolve(repo, file), "utf8")))
      hits.push(`${file}:${line}`);
  // Translate the line. If the CJK is the subject matter, mark it as described above.
  expect(hits).toEqual([]);
});

it("honors the line marker and marked blocks only", () => {
  const text = [
    "English line.",
    "中文行",
    "Glossary term 消息文本 <!-- cjk-ok -->",
    "<!-- cjk-ok:start -->",
    "| 机票 | Boarding pass |",
    "<!-- cjk-ok:end -->",
    "```sh",
    "echo 你好",
    "```",
    "Fullwidth comma，here",
    "かな and 한글",
  ].join("\n");
  expect(cjkLines(text)).toEqual([2, 8, 10, 11]);
});

it("reports a block start marker that is never closed", () => {
  const text = ["English line.", "<!-- cjk-ok:start -->", "中文行", "更多中文"].join("\n");
  expect(cjkLines(text)).toEqual([2]);
});

it("allows only the Chinese README and locale data", () => {
  for (const ok of ["README.zh-CN.md", "apps/desktop/src/renderer/src/locales/zh-CN/notes.md"])
    expect(ALLOWED_FILE.test(ok), ok).toBe(true);
  for (const bad of ["README.md", "docs/README.zh-CN.md", "docs/localization.md"])
    expect(ALLOWED_FILE.test(bad), bad).toBe(false);
});
