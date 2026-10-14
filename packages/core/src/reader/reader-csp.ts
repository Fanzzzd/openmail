/**
 * Content Security Policies for documents that hold untrusted mail HTML: the
 * desktop reader iframe, the mobile reader WebView and the print document.
 * Stylesheets never load from the network: a fetched sheet's own url() and
 * @import would skip the tracker and pixel filters that the mail's HTML went
 * through. Remote images load only when the user's setting allows them for the
 * message; known trackers are stripped before that in `prepareMessageHtml`.
 */
const policy = (...directives: readonly string[]) => directives.join("; ");

/** Directives every mail document carries: no scripts, plugins, frames, requests, base or forms. */
export const READER_CSP_RESTRICTIONS = policy(
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
);

/** Inline styles and embedded data only. */
export const READER_CSP_BLOCKED = policy(
  "default-src 'none'",
  "img-src data: cid:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  READER_CSP_RESTRICTIONS,
);

/** The blocked policy plus HTTPS images and fonts, for messages whose remote images may load. */
export const READER_CSP_REMOTE_IMAGES = policy(
  "default-src 'none'",
  "img-src data: cid: https:",
  "style-src 'unsafe-inline'",
  "font-src data: https:",
  READER_CSP_RESTRICTIONS,
);

/** Print resolves inline images to data: URLs first, so it also drops cid:. */
export const PRINT_CSP = policy(
  "default-src 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  READER_CSP_RESTRICTIONS,
);

export function readerCsp(remoteImages: boolean): string {
  return remoteImages ? READER_CSP_REMOTE_IMAGES : READER_CSP_BLOCKED;
}
