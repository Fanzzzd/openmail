#!/usr/bin/env node
// Moves files with `git mv` and rewrites every relative specifier that points at them.
//
//   node scripts/move-files.mjs moves.json [--dry-run]
//
// moves.json is a list of groups: [{ "base": "apps/desktop/src/renderer/src", "moves": { "App.tsx": "app/App.tsx" } }]
//
// Rewritten in apps/desktop and apps/docs: import/export ... from, import(), typeof import(),
// require(), vi.mock/doMock/importActual/..., and new URL("…", import.meta.url) in tests and
// scripts. Non-test files in src/main keep their new URL paths: those resolve against the
// bundled out/main/index.js, not the source file. Markdown files and e2e-mutations.mjs get
// their path mentions updated too.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const [movesFile, ...flags] = process.argv.slice(2);
if (!movesFile) throw new Error("usage: node scripts/move-files.mjs moves.json [--dry-run]");
const dryRun = flags.includes("--dry-run");

const moves = new Map();
for (const group of JSON.parse(readFileSync(movesFile, "utf8"))) {
  for (const [from, to] of Object.entries(group.moves)) {
    const source = path.join(repo, group.base, from);
    const target = path.join(repo, group.base, to);
    if (!existsSync(source)) throw new Error(`missing source: ${path.relative(repo, source)}`);
    if (existsSync(target)) throw new Error(`target exists: ${path.relative(repo, target)}`);
    moves.set(source, target);
  }
}
const moved = (file) => moves.get(file) ?? file;

const skipped = new Set(["node_modules", "out", "dist", ".turbo", "locales"]);
const walk = (directory, pattern) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return skipped.has(entry.name) ? [] : walk(full, pattern);
    return pattern.test(entry.name) ? [full] : [];
  });
const code = /\.(?:[cm]?[jt]sx?|d\.ts)$/;
const sources = [
  ...walk(path.join(repo, "apps/desktop"), code),
  ...walk(path.join(repo, "apps/docs"), code),
];
const markdown = walk(repo, /\.md$/).filter((file) => !file.includes(`${path.sep}node_modules`));

const isFile = (file) => existsSync(file) && statSync(file).isFile();
const candidates = (base) => [
  base,
  `${base}.ts`,
  `${base}.tsx`,
  `${base}.mjs`,
  `${base}.js`,
  path.join(base, "index.ts"),
  path.join(base, "index.tsx"),
  base.replace(/\.js$/, ".ts"),
  base.replace(/\.js$/, ".tsx"),
];

/** New spelling of `specifier` written in `file`, which moves from `from` to `to`. */
function rewrite(specifier, from, to) {
  if (!specifier.startsWith(".")) return specifier;
  const absolute = path.resolve(path.dirname(from), specifier);
  const target = candidates(absolute).find(isFile);
  let next;
  if (target) {
    const destination = moved(target);
    let base;
    if (!target.startsWith(absolute)) {
      // "./x.js" naming x.ts or x.tsx.
      base = destination.replace(/\.tsx?$/, ".js");
    } else {
      // Keep the specifier's own suffix: none, /index omitted, or the full extension.
      const suffix = target.slice(absolute.length);
      if (!destination.endsWith(suffix))
        throw new Error(`cannot keep suffix ${suffix} for ${destination}`);
      base = destination.slice(0, destination.length - suffix.length);
    }
    next = path.relative(path.dirname(to), base);
  } else {
    // A directory or a build output: plain path arithmetic.
    next = path.relative(path.dirname(to), absolute);
    if (specifier.endsWith("/")) next += "/";
  }
  next = next.split(path.sep).join("/");
  if (!next.startsWith(".")) next = `./${next}`;
  return next;
}

const bundledMain = (file) =>
  file.includes(`${path.sep}apps${path.sep}desktop${path.sep}src${path.sep}main${path.sep}`) &&
  !/\.test\.tsx?$/.test(file);

function rewriteSource(text, from, to) {
  const swap = (_match, head, quote, specifier) =>
    `${head}${quote}${rewrite(specifier, from, to)}${quote}`;
  let out = text
    .replace(/(\bfrom\s*)(["'])(\.[^"'\n]*)\2/g, swap)
    .replace(/(\bimport\s*)(["'])(\.[^"'\n]*)\2/g, swap)
    .replace(/(\bimport\(\s*)(["'])(\.[^"'\n]*)\2/g, swap)
    .replace(/(\brequire\(\s*)(["'])(\.[^"'\n]*)\2/g, swap)
    .replace(/(\bvi\.\w+\(\s*)(["'])(\.[^"'\n]*)\2/g, swap);
  if (!bundledMain(from)) {
    out = out.replace(
      /(\bnew URL\(\s*)(["'])(\.[^"'\n]*)\2(\s*,\s*import\.meta\.url)/g,
      (_match, head, quote, specifier, tail) =>
        `${head}${quote}${rewrite(specifier, from, to)}${quote}${tail}`,
    );
    // Template literals: rewrite the static directory prefix before the first ${.
    out = out.replace(
      /(\bnew URL\(\s*`)(\.[^`$]*\/)(\$\{[^`]*`\s*,\s*import\.meta\.url)/g,
      (_match, head, prefix, tail) => `${head}${rewrite(prefix, from, to)}${tail}`,
    );
  }
  return out;
}

// Path mentions in prose, comments and path strings: `renderer/src/<old>` and `main/<old>`.
const mentions = [...moves].flatMap(([from, to]) => {
  for (const anchor of ["apps/desktop/src/renderer/src/", "apps/desktop/src/main/"]) {
    const root = path.join(repo, anchor);
    if (!from.startsWith(root)) continue;
    const short = anchor.includes("renderer") ? "renderer/src/" : "main/";
    const before = from.slice(root.length);
    const after = to.slice(root.length);
    return [[`${short}${before}`, `${short}${after}`]];
  }
  return [];
});
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentionMap = new Map(mentions);
const mentionPattern = new RegExp(
  `(?<![\\w-])(${[...mentionMap.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map(escape)
    .join("|")})(?![\\w.-])`,
  "g",
);
/** One pass, so a rewritten path is never rewritten again. */
const rewriteMentions = (text) =>
  mentionMap.size ? text.replace(mentionPattern, (match) => mentionMap.get(match) ?? match) : text;
// e2e-mutations.mjs names renderer files as `${renderer}<path>`.
const rest = (value) => value.slice("renderer/src/".length);
function rewriteMutations(text) {
  let out = text;
  for (const [before, after] of mentions) {
    if (!before.startsWith("renderer/src/")) continue;
    out = out.replace(
      new RegExp(`(\\$\\{renderer\\})${escape(rest(before))}(?![\\w.-])`, "g"),
      `$1${rest(after)}`,
    );
  }
  return out;
}

const writes = new Map();
for (const file of sources) {
  const to = moved(file);
  const text = readFileSync(file, "utf8");
  let next = rewriteMentions(rewriteSource(text, file, to));
  if (file.endsWith("e2e-mutations.mjs")) next = rewriteMutations(next);
  if (next !== text || to !== file) writes.set(to, next);
}
for (const file of markdown) {
  const text = readFileSync(file, "utf8");
  const next = rewriteMentions(text);
  if (next !== text) writes.set(file, next);
}

if (dryRun) {
  for (const [from, to] of moves)
    console.log(`mv ${path.relative(repo, from)} -> ${path.relative(repo, to)}`);
  for (const file of writes.keys()) console.log(`write ${path.relative(repo, file)}`);
} else {
  for (const [from, to] of moves) {
    mkdirSync(path.dirname(to), { recursive: true });
    execFileSync("git", ["mv", from, to], { cwd: repo });
  }
  for (const [file, text] of writes) writeFileSync(file, text);
  console.log(`moved ${moves.size} files, rewrote ${writes.size}`);
}
