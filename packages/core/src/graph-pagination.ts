const resources = new Set([
  "me",
  "mailfolders",
  "childfolders",
  "messages",
  "contactfolders",
  "contacts",
  "people",
  "calendar",
  "calendars",
  "calendarview",
  "events",
  "outlook",
  "mastercategories",
]);

/** Compare resource paths while accepting Graph's equivalent OData key segments. */
function resourcePath(path: string) {
  return path
    .replace(
      /([a-z]+)\('((?:[^']|'')*)'\)/gi,
      (_match: string, resource: string, key: string) =>
        `${resource}/${encodeURIComponent(decodeURIComponent(key).replaceAll("''", "'"))}`,
    )
    .split("/")
    .map((segment) => {
      const decoded = decodeURIComponent(segment);
      return resources.has(decoded.toLowerCase())
        ? decoded.toLowerCase()
        : encodeURIComponent(decoded);
    })
    .join("/");
}

function resourceFamily(path: string): string | undefined {
  const canonical = resourcePath(path);
  if (/^\/me\/mailfolders\/[^/]+(?:\/childfolders\/[^/]+)*\/messages$/.test(canonical))
    return "folder-messages";
  if (/^\/me\/mailfolders(?:\/[^/]+(?:\/childfolders\/[^/]+)*\/childfolders)?$/.test(canonical))
    return "mail-folders";
  if (/^\/me\/contactfolders(?:\/[^/]+(?:\/childfolders\/[^/]+)*\/childfolders)?$/.test(canonical))
    return "contact-folders";
  if (
    canonical === "/me/contacts" ||
    /^\/me\/contactfolders\/[^/]+(?:\/childfolders\/[^/]+)*\/contacts$/.test(canonical)
  )
    return "contacts";
  if (
    canonical === "/me/calendarview" ||
    /^\/me\/(?:calendar|calendars\/[^/]+)\/calendarview$/.test(canonical)
  )
    return "calendar-view";
  if (canonical === "/me/people") return "people";
  if (canonical === "/me/messages") return "messages";
  return undefined;
}

/** Validate the token destination and resource family; preserve the server URL and opaque query. */
export function graphPageLink(link: string, base: string): string {
  const url = new URL(link);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/v1.0/me/")
  )
    throw new Error("Invalid Graph pagination link");
  // Well-known aliases may become actual folder IDs in server-generated links.
  const actual = resourceFamily(url.pathname.slice("/v1.0".length));
  if (actual === undefined || actual !== resourceFamily(base))
    throw new Error("Invalid Graph pagination resource");
  return link;
}
