import { expect, it } from "vitest";
import { resolveUpdateFeed, selectUpdateRelease } from "./update-feed.js";

const download = (tag: string, name: string) =>
  `https://github.com/Fanzzzd/openmail/releases/download/${tag}/${name}`;
const release = (tag_name: string, prerelease = false, draft = false) => ({
  tag_name,
  prerelease,
  draft,
  assets: [{ name: "latest-mac.yml", browser_download_url: download(tag_name, "latest-mac.yml") }],
});
const href = (input: Parameters<typeof fetch>[0]) =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

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
it("core resolves both public feeds and downloads only the chosen manifest, with no credentials", async () => {
  const calls: { url: string; authorization: unknown }[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = href(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/latest")) return Response.json(release("v2.0.0"));
    if (url.includes("?per_page=")) return Response.json([release("v1.9.0-beta.1", true)]);
    if (url === download("v2.0.0", "latest-mac.yml"))
      return new Response(null, {
        status: 302,
        headers: { location: "https://release-assets.githubusercontent.com/manifest" },
      });
    return new Response("version: 2.0.0");
  };
  const feed = await resolveUpdateFeed("latest", "latest-mac.yml", request);
  expect(feed).toMatchObject({
    version: "2.0.0",
    tag: "v2.0.0",
    manifestUrl: download("v2.0.0", "latest-mac.yml"),
  });
  expect(calls.map((call) => call.url)).toEqual([
    "https://api.github.com/repos/Fanzzzd/openmail/releases/latest",
    "https://api.github.com/repos/Fanzzzd/openmail/releases?per_page=100&page=1",
    download("v2.0.0", "latest-mac.yml"),
    "https://release-assets.githubusercontent.com/manifest",
  ]);
  expect(calls.every((call) => call.authorization === null)).toBe(true);
});
it("a manifest URL outside the chosen release, or a redirect off GitHub, is rejected", async () => {
  const feed = (manifestUrl: string, location?: string) => {
    const request: typeof fetch = async (input) => {
      const url = href(input);
      if (url.endsWith("/latest"))
        return Response.json({
          ...release("v2.0.0"),
          assets: [{ name: "latest-mac.yml", browser_download_url: manifestUrl }],
        });
      return location
        ? new Response(null, { status: 302, headers: { location } })
        : new Response("version: 2.0.0");
    };
    return resolveUpdateFeed("stable", "latest-mac.yml", request);
  };
  await expect(feed(download("v1.0.0", "latest-mac.yml"))).rejects.toThrow("Invalid update asset");
  await expect(
    feed("https://example.com/Fanzzzd/openmail/releases/download/v2.0.0/latest-mac.yml"),
  ).rejects.toThrow("Invalid update asset");
  await expect(
    feed(download("v2.0.0", "latest-mac.yml"), "https://example.com/manifest"),
  ).rejects.toThrow("Invalid update asset redirect");
  expect((await feed(download("v2.0.0", "latest-mac.yml"))).version).toBe("2.0.0");
});
it("no stable release still allows a prerelease; Stable never queries prereleases or accepts one as stable", async () => {
  const urls: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = href(input);
    urls.push(url);
    return url.endsWith("/latest")
      ? new Response(null, { status: 404 })
      : url.includes("?per_page")
        ? Response.json([release("v1.0.0-beta.1", true)])
        : new Response("version: 1.0.0-beta.1");
  };
  expect((await resolveUpdateFeed("latest", "latest-mac.yml", request)).version).toBe(
    "1.0.0-beta.1",
  );
  urls.length = 0;
  await expect(resolveUpdateFeed("stable", "latest-mac.yml", request)).rejects.toThrow();
  expect(urls).toHaveLength(1);
});
