import { Buffer } from "../platform/bytes.js";
import { Schema } from "effect";
import compare from "semver/functions/compare.js";
import parse from "semver/functions/parse.js";

const Release = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(Schema.Struct({ name: Schema.String, browser_download_url: Schema.String })),
});
type Release = typeof Release.Type;
const API = "https://api.github.com/repos/Fanzzzd/openmail/releases";
/** Public release downloads: https://github.com/Fanzzzd/openmail/releases/download/<tag>/<file>. */
const DOWNLOAD = "https://github.com/Fanzzzd/openmail/releases/download/";
const ASSET_HOSTS = new Set([
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
]);

/** Choose the greater semver between the stable release and the newest eligible prerelease. */
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

/** Called by the updater adapter only after core's signature and package gate. All HTTP stays in core.
 * The repo is public, so no request carries credentials. */
export async function resolveUpdateFeed(
  channel: "stable" | "latest",
  manifestName: string,
  request: typeof fetch = fetch,
) {
  const get = (url: string) =>
    request(url, {
      headers: { accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
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
  // The updater SDK builds package URLs from the tag; the manifest must come from the same release.
  const url = new URL(asset.browser_download_url);
  if (
    url.href !==
    `${DOWNLOAD}${encodeURIComponent(selected.tag_name)}/${encodeURIComponent(manifestName)}`
  )
    throw new Error("Invalid update asset URL");
  let response = await request(url.href, {
    headers: { accept: "application/octet-stream" },
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = new URL(response.headers.get("location") ?? "");
    if (!ASSET_HOSTS.has(location.origin) || location.username || location.password)
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
  return { manifest, manifestUrl: url.href, version: version.version, tag: selected.tag_name };
}
