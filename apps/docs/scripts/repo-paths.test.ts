import { execFileSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The contributor docs name source files by path. A move or rename leaves those paths stale,
// so every repo path they mention must still exist. turbo.json turns caching off for this
// task because the answer depends on files outside apps/docs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const documents = [
  "CONTRIBUTING.md",
  ...globSync("docs/**/*.md", { cwd: root, exclude: ["docs/design/**"] }),
].toSorted();
const topLevel = new Set(readdirSync(root));
const packages = globSync("{apps,packages}/*/", { cwd: root });

interface Mention {
  document: string;
  path: string;
  /** Markdown link targets resolve from the document; everything else from the repo root. */
  link: boolean;
}

function mentions(document: string): Mention[] {
  const text = readFileSync(join(root, document), "utf8");
  const blocks = [...text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]!);
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  return [
    ...[...prose.matchAll(/\]\(<?([^)\s>]+)>?\)/g)].map((match) => ({
      path: match[1]!,
      link: true,
    })),
    ...[...prose.matchAll(/`([^`\s]+)`/g)].map((match) => ({ path: match[1]!, link: false })),
    ...blocks.flatMap((block) => block.split(/\s+/)).map((path) => ({ path, link: false })),
  ].map((mention) => ({ document, ...mention }));
}

/** Only relative links and slash paths under a real top-level directory or a package's src. */
function isRepoPath({ path, link }: Mention) {
  if (link) return !/^([a-z][a-z+.-]*:|#|\/)/i.test(path);
  if (!path.includes("/") || /[<>$…'"=]|\.\.\.|\{[^,}]*\}/.test(path)) return false;
  const first = path.split("/")[0]!;
  return topLevel.has(first) || first === "src";
}

function exists({ document, path, link }: Mention) {
  const clean = path.replace(/[#?].*$/, "").replace(/[:,.;)]+$/, "");
  if (clean === "") return true;
  if (link) return existsSync(join(root, dirname(document), decodeURIComponent(clean)));
  const found = (candidate: string) =>
    /[*{]/.test(candidate)
      ? globSync(candidate, { cwd: root }).length > 0
      : existsSync(join(root, candidate));
  // Commands in the testing docs name `src/…` relative to the package they run in.
  return clean.startsWith("src/") ? packages.some((dir) => found(join(dir, clean))) : found(clean);
}

/** Paths git ignores are local files or build output: oauth-clients.local.json, release/. */
function ignored(paths: string[]) {
  if (paths.length === 0) return new Set<string>();
  try {
    const output = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: root,
      input: paths.join("\n"),
      encoding: "utf8",
    });
    return new Set(output.split("\n").filter(Boolean));
  } catch (error) {
    // Exit status 1: none of the paths is ignored.
    if (error instanceof Error && "status" in error && error.status === 1) return new Set<string>();
    throw error;
  }
}

test("docs name only repo paths that exist", () => {
  const missing = documents
    .flatMap(mentions)
    .filter((mention) => isRepoPath(mention) && !exists(mention));
  const local = ignored(missing.filter(({ link }) => !link).map(({ path }) => path));
  expect(
    missing
      .filter(({ path, link }) => link || !local.has(path))
      .map(({ document, path }) => `${document}: ${path}`),
  ).toEqual([]);
});

test("the check reads the contributor docs", () => {
  expect(documents).toEqual(expect.arrayContaining(["CONTRIBUTING.md", "docs/testing.md"]));
});
