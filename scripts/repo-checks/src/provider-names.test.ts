import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = resolve(fileURLToPath(new URL("./", import.meta.url)), "../../..");
const SOURCES = [
  "packages/core/src",
  "packages/cli/src",
  "apps/desktop/src",
  "apps/mobile/app",
  "apps/mobile/src",
];
/**
 * `provider === "gmail"`, `a.provider !== 'imap'`, the same with the literal first,
 * `switch (account.provider)` and each `case "outlook":`. A switch with three cases counts four.
 */
const COMPARISON = new RegExp(
  [
    /\bprovider\s*[!=]==\s*["'`]/,
    /["'`](?:gmail|outlook|imap)["'`]\s*[!=]==\s*[\w.?]*provider\b/,
    /\bswitch\s*\(\s*[\w.?]*\bprovider\s*\)/,
    /\bcase\s+["'`](?:gmail|outlook|imap)["'`]\s*:/,
  ]
    .map((pattern) => pattern.source)
    .join("|"),
  "g",
);

/**
 * Provider code: the adapters, the capability table and the platform layers
 * may branch on the name. Shared files in providers/ (ports, OAuth scopes,
 * the scoped adapter) are counted like any other caller.
 */
const ALLOWED = [
  "packages/core/src/providers/gmail/",
  "packages/core/src/providers/outlook/",
  "packages/core/src/providers/imap/",
  "packages/core/src/providers/capabilities.ts",
  "packages/core/src/platform/",
];

/**
 * Identity uses outside providers/. These pick a brand name, an icon or an
 * OAuth client, or build test fixtures. They are not rules about what an
 * account can do.
 */
const IDENTITY = new Set([
  // Gmail and Outlook OAuth client setup.
  "apps/desktop/src/renderer/src/features/accounts/AddAccountDialog.tsx",
  "apps/desktop/src/renderer/src/state/mutations.ts",
  "apps/desktop/src/shared/mailbox-handlers.ts",
  "apps/mobile/app/index.tsx",
  // The provider's own name in copy.
  "apps/desktop/src/renderer/src/ui/ProviderIcon.tsx",
  "apps/desktop/src/renderer/src/features/sync-status/MailStatusNotice.tsx",
  "apps/desktop/src/renderer/src/features/accounts/OptionalServices.tsx",
  "apps/desktop/src/renderer/src/features/reader/use-thread-mail-actions.ts",
  // Fake accounts for end-to-end tests.
  "apps/desktop/src/renderer/src/e2e/harness.ts",
]);

/**
 * Comparisons that remain outside the adapters, per file. Each is protocol
 * detail (ID formats, cursor layout, endpoint choice, size limits) that
 * belongs in the adapter or in providers/sync-profile.ts, not a capability
 * callers read.
 * Lower a count when you move one into the adapter; never raise it. A new
 * question about what an account can do goes into providerCapabilities.
 */
const REMAINING: Record<string, number> = {
  // OAuth sign-in input per provider, and the OAuth client the account uses.
  "packages/core/src/mailbox/mailbox-accounts.ts": 1,
  "apps/desktop/src/renderer/src/features/settings/Settings.tsx": 2,
  // Protocol detail.
  "packages/core/src/calendar/event-recurrence.ts": 1,
  "packages/core/src/calendar/provider-calendar.ts": 4,
  "packages/core/src/mailbox/mailbox-cache.ts": 1,
  "packages/core/src/mailbox/mailbox-drafts.ts": 5,
  "packages/core/src/mailbox/mailbox-flush.ts": 3,
  "packages/core/src/mailbox/mailbox-folders.ts": 1,
  "packages/core/src/mailbox/mailbox-live.ts": 1,
  "packages/core/src/mailbox/mailbox-reading.ts": 2,
  "packages/core/src/mime/attachment-policy.ts": 2,
  "packages/core/src/reader/message-security.ts": 3,
  "packages/core/src/reader/reading.ts": 4,
  "packages/core/src/search/provider-search.ts": 4,
};

function comparisons(): Record<string, number> {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...SOURCES],
    { cwd: repo, encoding: "utf8" },
  )
    .split("\n")
    .filter(
      (file) =>
        /\.(?:ts|tsx|mts|cts)$/.test(file) &&
        !/\.test\.tsx?$/.test(file) &&
        !ALLOWED.some((path) => file.startsWith(path)) &&
        !IDENTITY.has(file),
    );
  expect(files.length).toBeGreaterThan(100);
  const counts: Record<string, number> = {};
  for (const file of files) {
    const found = readFileSync(resolve(repo, file), "utf8").match(COMPARISON)?.length ?? 0;
    if (found) counts[file] = found;
  }
  return counts;
}

it("callers read providerCapabilities instead of comparing provider names", () => {
  // A new entry or a higher count means a rule written against a provider name.
  // Read the capability instead, or add the question to providers/capabilities.ts.
  expect(comparisons()).toEqual(REMAINING);
});

it("matches both operand orders and every quote style", () => {
  const sample = [
    'account.provider === "gmail"',
    "provider !== 'imap'",
    '"outlook" === account?.provider',
    "providerName === other",
    "switch (account.provider) {",
    "switch (a?.provider) {",
    'case "gmail":',
    "case 'imap': {",
    "switch (providerName) {",
    'case "focused":',
  ].join("\n");
  expect(sample.match(COMPARISON)).toHaveLength(7);
});

it("the identity list holds only files that still compare names", () => {
  for (const file of IDENTITY)
    expect(
      readFileSync(resolve(repo, file), "utf8").match(COMPARISON)?.length ?? 0,
      file,
    ).toBeGreaterThan(0);
});
