import { Buffer } from "./platform/bytes.js";
import { Schema } from "effect";
import { compare, parse } from "semver";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, url: Schema.String })),
});
type Release = typeof Release.Type;
const API = "https://api.github.com/repos/Fanzzzd/openmail/releases";

/** GitHub's private provider prefers the first prerelease even when stable has a higher version. */
export function selectUpdateRelease(
  stable: Release | null,
  releases: readonly Release[],
): Release | null {
  return (
    [...(stable ? [stable] : []), ...releases.filter((r) => r.prerelease)]
      .filter((r) => !r.draft && parse(r.tag_name))
      .toSorted((a, b) => compare(b.tag_name, a.tag_name))[0] ?? null
  );
}

/** Called by the updater adapter only after core's signature/package/keychain gate. All HTTP stays in core. */
export async function resolveUpdateFeed(
  token: string,
  channel: "stable" | "latest",
  manifestName: string,
  request: typeof fetch = fetch,
) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const get = (url: string, extra = {}) =>
    request(url, {
      headers: { ...headers, ...extra },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
  const stableResponse = await get(`${API}/latest`);
  if (!stableResponse.ok && !(channel === "latest" && stableResponse.status === 404))
    throw new Error("Could not resolve update release");
  const stable = stableResponse.ok
    ? Schema.decodeUnknownSync(Release)(await stableResponse.json())
    : null;
  const releases: Release[] = [];
  if (channel === "latest") {
    for (let page = 1; page <= 20; page++) {
      const response = await get(`${API}?per_page=100&page=${page}`);
      if (!response.ok) throw new Error("Could not resolve update release");
      const items = Schema.decodeUnknownSync(Schema.Array(Release))(await response.json());
      releases.push(...items);
      if (items.length < 100) break;
      if (page === 20) throw new Error("Too many update release pages");
    }
  }
  const selected = channel === "latest" ? selectUpdateRelease(stable, releases) : stable;
  const version = selected && parse(selected.tag_name);
  if (
    !selected ||
    selected.draft ||
    !version ||
    (channel === "stable" && (selected.prerelease || version.prerelease.length))
  )
    throw new Error("No eligible update release");
  const asset = selected.assets.find((a) => a.name === manifestName);
  if (!asset) throw new Error("Update manifest is unavailable");
  const url = new URL(asset.url);
  if (
    url.origin !== "https://api.github.com" ||
    url.username ||
    url.password ||
    !/^\/repos\/Fanzzzd\/openmail\/releases\/assets\/\d+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid update asset URL");
  // Validate every asset before the inherited updater can attach its bearer token.
  for (const item of selected.assets) {
    const location = new URL(item.url);
    if (
      location.origin !== url.origin ||
      location.username ||
      location.password ||
      !/^\/repos\/Fanzzzd\/openmail\/releases\/assets\/\d+$/.test(location.pathname) ||
      location.search ||
      location.hash
    )
      throw new Error("Invalid update asset URL");
  }
  let response = await get(url.href, { accept: "application/octet-stream" });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location") ?? "");
    if (
      ![
        "https://release-assets.githubusercontent.com",
        "https://objects.githubusercontent.com",
      ].includes(location.origin) ||
      location.username ||
      location.password
    )
      throw new Error("Invalid update asset redirect");
    response = await request(location.href, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  }
  if (!response.ok) throw new Error("Could not read update manifest");
  const manifest = await response.text();
  if (Buffer.byteLength(manifest) > 1024 * 1024) throw new Error("Update manifest is too large");
  return {
    manifest,
    manifestUrl: asset.url,
    version: version.version,
    assets: [...selected.assets],
  };
}
