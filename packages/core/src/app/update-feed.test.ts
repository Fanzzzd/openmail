import { expect, it } from "vitest";
import { resolveUpdateFeed, selectUpdateRelease } from "./update-feed.js";

const release = (tag_name: string, prerelease = false, draft = false) => ({
  tag_name,
  prerelease,
  draft,
  assets: [
    {
      name: "latest-mac.yml",
      url: "https://api.github.com/repos/Fanzzzd/openmail/releases/assets/123",
    },
  ],
});
it("Latest selects the greater semver between stable and the newest eligible prerelease", () => {
  const stable = release("v2.0.0");
  expect(selectUpdateRelease(stable, [release("v2.0.0-beta.9", true)])).toEqual(stable);
  expect(
    selectUpdateRelease(stable, [
      release("v2.1.0-beta.2", true),
      release("v2.1.0-beta.10", true),
      release("v9.0.0", true, true),
      release("bad-tag", true),
    ])?.tag_name,
  ).toBe("v2.1.0-beta.10");
});
it("core resolves both feeds and downloads only the chosen manifest without leaking credentials on redirects", async () => {
  const calls: { url: string; authorization: unknown }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/latest")) return Response.json(release("v2.0.0"));
    if (url.includes("?per_page=")) return Response.json([release("v1.9.0-beta.1", true)]);
    if (url.endsWith("/123"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/manifest" },
      });
    return new Response("version: 2.0.0");
  };
  expect((await resolveUpdateFeed("test-token", "latest", "latest-mac.yml", request)).version).toBe(
    "2.0.0",
  );
  expect(calls).toHaveLength(4);
  expect(calls[3]?.authorization).toBeNull();
  expect(calls.slice(0, 3).every((call) => call.authorization === "Bearer test-token")).toBe(true);
});
it("no stable release still allows a prerelease; Stable never queries prereleases or accepts one as stable", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return url.endsWith("/latest")
      ? new Response(null, { status: 404 })
      : url.includes("?per_page")
        ? Response.json([release("v1.0.0-beta.1", true)])
        : new Response("version: 1.0.0-beta.1");
  };
  expect((await resolveUpdateFeed("test", "latest", "latest-mac.yml", request)).version).toBe(
    "1.0.0-beta.1",
  );
  urls.length = 0;
  await expect(resolveUpdateFeed("test", "stable", "latest-mac.yml", request)).rejects.toThrow();
  expect(urls).toHaveLength(1);
});
