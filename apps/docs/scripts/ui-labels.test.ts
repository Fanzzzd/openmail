import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The docs quote app UI labels in bold. When the app renames a label, the quote goes stale,
// so every bold label must still be an English UI string: a Lingui msgid or a main-process
// label. turbo.json turns caching off for this task because the answer depends on files
// outside apps/docs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** Bold text that is not an OpenMail label: lead-ins that title a paragraph, and other apps' UI. */
const NOT_OPENMAIL_UI = new Set([
  // Paragraph lead-ins
  "AI.",
  "Assistant.",
  "CLI and MCP.",
  "Compose.",
  "Gmail.",
  "IMAP.",
  "Mac app.",
  "On-device indexing.",
  "Outlook.",
  "Read and search.",
  "Summaries.",
  "Sync and organize.",
  "Testing.",
  "Triage suggestions.",
  // Names the app shows as written, outside the catalog
  "Claude",
  "Claude Code",
  "Codex",
  "Cursor",
  "Gmail",
  "Outlook",
  "In production",
  "Related",
  "The page doesn't load.",
  // Google Cloud, Google Auth Platform and Google's sign-in warning
  "Advanced",
  "APIs & Services → Library",
  "Audience",
  "Clients → Create client",
  "Data Access",
  "Desktop app",
  "External",
  "Gmail API",
  "Google Auth Platform → Branding",
  "Google Calendar API",
  "Google hasn't verified this app",
  "People API",
  "Test users",
  // Microsoft Entra admin center
  "API permissions → Add a permission → Microsoft Graph → Delegated permissions",
  "Allow public client flows",
  "Application (client) ID",
  "Authentication",
  "Microsoft Entra ID → App registrations → New registration",
  "Personal Microsoft accounts only",
  "Public client/native (mobile & desktop)",
  "Redirect URI",
  "Supported account types",
  // macOS
  "Always Allow",
  "Deny",
  "Open Anyway",
  "System Settings → Privacy & Security",
  // Tailscale admin console and browsers
  "Advanced: Tailscale Service",
  "Go to OpenMail (unsafe)",
]);

/** A JSON string body with its escapes read; .po files and TS literals share them. */
function unquote(body: string): string {
  const value: unknown = JSON.parse(`"${body}"`);
  return typeof value === "string" ? value : body;
}

function poMsgids(text: string): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/^msgid ((?:"(?:[^"\\]|\\.)*"\n?)+)/gm))
    ids.push(
      [...match[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((part) => unquote(part[1]!)).join(""),
    );
  return ids.filter(Boolean);
}

/** String literals of main-process labels that do not go through Lingui. */
const literals = (text: string) =>
  [...text.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map((match) => unquote(match[1]!));

const uiTexts = [
  ...poMsgids(read("apps/desktop/src/renderer/src/locales/en/messages.po")),
  ...literals(read("apps/desktop/src/main/system/default-labels.ts")),
  ...literals(read("apps/desktop/src/main/app/native-i18n.ts")),
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each UI text as anchored patterns: the whole text, each sentence of it and each plural
 * branch. `#` matches a number, so "3 changes couldn't be saved" matches
 * "{count, plural, ... other {# changes couldn't be saved}}". An ICU argument matches any
 * text or none, so "Sign in with Google" and "Synced" match "Sign in with {name}" and
 * "Synced {time}". Texts with little else besides arguments, such as "{0}…", match nothing.
 */
const patterns = uiTexts.flatMap((text) => {
  const branches = [...text.matchAll(/(?:zero|one|two|few|many|other|=\d+)\s*\{([^{}]*)\}/g)].map(
    (match) => match[1]!,
  );
  const units = [text, ...branches].flatMap((unit) => [
    unit,
    ...unit.split(/(?<=[.!?])\s+/).filter((sentence) => sentence !== unit),
  ]);
  return units
    .filter((unit) => !unit.includes("{") || unit.replace(/\{[^{}]*\}|[^a-z]/gi, "").length >= 6)
    .map(
      (unit) =>
        new RegExp(
          `^${escape(unit)
            .replace(/ ?\\\{[^{}]*?\\\}/g, "(?: ?.+)?")
            .replace(/#/g, "[\\d,]+")
            .replace(/\\\.$|$/, "\\.?")}$`,
        ),
    );
});

const isUiText = (label: string) => {
  const text = label.replace(/^"(.*)"$/, "$1");
  return patterns.some((pattern) => pattern.test(text) || pattern.test(text.replace(/\.$/, "")));
};

const documents = [
  ...globSync("apps/docs/content/docs/*.mdx", { cwd: root }),
  "apps/docs/app/(home)/page.tsx",
].toSorted();

const boldLabels = (document: string) =>
  [...read(document).matchAll(/\*\*([^*\n]+?)\*\*/g)].map((match) => match[1]!.trim());

test("finds the UI texts and bold labels it checks", () => {
  expect(uiTexts.length).toBeGreaterThan(800);
  expect(isUiText("Allow AI suggestions")).toBe(true);
  expect(isUiText("3 changes couldn't be saved.")).toBe(true);
  expect(isUiText("You're offline.")).toBe(true);
  expect(isUiText("Send Feedback…")).toBe(false);
  expect(isUiText("Custom")).toBe(false);
  expect(boldLabels("apps/docs/app/(home)/page.tsx")).toContain("Allow AI suggestions");
});

test.each(documents)("bold UI labels in %s match the app", (document) => {
  const stale = boldLabels(document)
    .filter((label) => !NOT_OPENMAIL_UI.has(label))
    .flatMap((label) => label.split(" → "))
    .filter((segment) => !isUiText(segment));
  expect(stale).toEqual([]);
});
