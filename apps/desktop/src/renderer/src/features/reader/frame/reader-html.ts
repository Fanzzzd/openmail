import createDOMPurify from "dompurify";
import {
  READER_VIEWPORT_HEIGHT,
  sanitizeReaderHtml as portableSanitize,
} from "@openmail/core/schema";

/**
 * The browser's HTML parser is the final sanitizer before srcdoc reparse.
 * Core marks `searchTerms` in the cleaned text before that pass, and turns
 * viewport-height units into px: the frame takes its height from the page.
 */
export function sanitizeReaderHtml(
  html: string,
  remote: boolean,
  searchTerms: readonly string[] = [],
): string {
  const clean = portableSanitize(html, remote, undefined, searchTerms, READER_VIEWPORT_HEIGHT);
  const purifier = createDOMPurify(window);
  // The Node component harness has a partial DOM. It still gets the portable
  // allow-list; Chromium and jsdom support the final browser sanitizer.
  if (!purifier.isSupported) return clean;
  return purifier.sanitize(clean, {
    USE_PROFILES: { html: true },
    FORCE_BODY: true,
    ADD_TAGS: ["style"],
    ADD_ATTR: [
      "rules",
      "frame",
      "span",
      "hspace",
      "vspace",
      "face",
      "size",
      "name",
      "usemap",
      "coords",
      "shape",
      "link",
      "vlink",
      "alink",
      "bgcolor",
      "text",
    ],
    FORBID_TAGS: ["form", "input", "button", "select", "textarea", "meta", "base", "link"],
  });
}
