import { Schema } from "effect";
import { Address } from "../domain/message.js";
import { CalendarInvite } from "../calendar/calendar.js";
import { parseCalendar } from "../calendar/invites.js";
import { prepareMessageHtml } from "../reader/reader-html.js";
import { isEmailAddress } from "../compose/recipients.js";
import { cleanDisplayName } from "../reader/message-security.js";

const unescape = (value: string) => value.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** Active document formats and OS import formats never go to a native opener. */
export function attachmentImportKind(file: {
  filename: string;
  mimeType: string;
}): "html" | "calendar" | "contacts" | null {
  if (
    /\.(html?|xhtml|svg|shtml|mht|mhtml)$/i.test(file.filename) ||
    /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)$/i.test(file.mimeType)
  )
    return "html";
  if (/\.(ics|vcs)$/i.test(file.filename) || /^text\/(calendar|x-vcalendar)$/i.test(file.mimeType))
    return "calendar";
  if (
    /\.(vcf|vcard)$/i.test(file.filename) ||
    /^text\/((x-)?vcard|directory)$/i.test(file.mimeType)
  )
    return "contacts";
  return null;
}
export const AttachmentInspection = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("html"), html: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("calendar"), invites: Schema.Array(CalendarInvite) }),
  Schema.Struct({ kind: Schema.Literal("contacts"), contacts: Schema.Array(Address) }),
]);
export type AttachmentInspection = typeof AttachmentInspection.Type;
export function inspectAttachment(content: {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}): AttachmentInspection | null {
  if (content.data.byteLength > 1024 * 1024) return null;
  const text = new TextDecoder().decode(content.data);
  switch (attachmentImportKind(content)) {
    case "html":
      return { kind: "html", html: prepareMessageHtml(text).html };
    case "calendar":
      return { kind: "calendar", invites: parseCalendar(text, true).map((p) => p.invite) };
    case "contacts": {
      const contacts: Address[] = [];
      for (const card of text
        .replace(/\r?\n[ \t]/g, "")
        .matchAll(/BEGIN:VCARD\s*\r?\n([\s\S]*?)END:VCARD/gi)) {
        const lines = (card[1] ?? "").split(/\r?\n/);
        const name = cleanDisplayName(
          unescape(
            lines
              .find((line) => /^FN(?:;[^:]*)?:/i.test(line))
              ?.split(":")
              .slice(1)
              .join(":") ?? "",
          ),
        );
        for (const line of lines.filter((entry) => /^EMAIL(?:;[^:]*)?:/i.test(entry))) {
          const address = unescape(line.slice(line.indexOf(":") + 1)).trim();
          if (isEmailAddress(address)) contacts.push({ name, address });
          if (contacts.length >= 100) return { kind: "contacts", contacts };
        }
      }
      return { kind: "contacts", contacts };
    }
  }
  return null;
}
