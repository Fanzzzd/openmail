import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { privateUpdateFeed } from "./update-feed";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const resources = (yml?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "openmail-feed-"));
  dirs.push(dir);
  if (yml !== undefined) writeFileSync(join(dir, "app-update.yml"), yml);
  return dir;
};

it("asks for a GitHub token only when the packaged feed is a private repo", () => {
  expect(
    privateUpdateFeed(
      resources("owner: Fanzzzd\nrepo: openmail\nprovider: github\nprivate: true\n"),
    ),
  ).toBe(true);
  expect(privateUpdateFeed(resources("owner: someone\nrepo: openmail\nprovider: github\n"))).toBe(
    false,
  );
  expect(privateUpdateFeed(resources("provider: github\nprivate: false\n"))).toBe(false);
  // A development run or a build without a publish entry has no feed at all.
  expect(privateUpdateFeed(resources())).toBe(false);
  expect(privateUpdateFeed(null)).toBe(false);
});
