import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Each selected test must fail after an actual behavior change. Always restore the working file.
const desktop = fileURLToPath(new URL("..", import.meta.url));
const shared = "src/shared/mailbox-handlers.ts";
const renderer = "src/renderer/src/";
export const cases = [
  [
    "HTML draft import",
    "server HTML opens|keeps unsupported tables|opens in the rich composer",
    `${renderer}features/compose/draft.ts`,
    "body: outgoingComposeBody(m),",
    'body: { kind: "plain", text: m.text },',
  ],
  [
    "draft transport preview",
    "preserved draft preview|forward preview",
    `${renderer}features/compose/compose-preview.ts`,
    "return prepareMessageHtml(transport, { inline }).html;",
    'return "<p>SECRET</p>";',
  ],
  [
    "unsaved draft status",
    "never-saved composer",
    shared,
    "DraftStatus: ({ id }) => m.compose.draftStatus(id),",
    "DraftStatus: ({ id }) => m.compose.openDraft(id),",
  ],
  [
    "sync",
    "first sync",
    shared,
    "Effect.andThen(m.sync.sync())",
    "Effect.andThen(Effect.succeed([]))",
  ],
  [
    "read delay",
    "opening a thread",
    `${renderer}app/use-mail-selection.ts`,
    "markReadAfter(prefs.markReadDelay",
    "markReadAfter(0",
  ],
  [
    "organization",
    "archive advances|trash advances|Gmail labels|offline archive|moves to one folder|provider latency",
    shared,
    "m.organize.modifyWithUndo(threads, op, flat)",
    "m.organize.modifyWithUndo([], op, flat)",
  ],
  [
    "snooze",
    "snooze advances",
    shared,
    "m.organize.snoozeWithUndo(threads, due)",
    "m.organize.snoozeWithUndo([], due)",
  ],
  [
    "autosave",
    "new compose autosaves",
    `${renderer}features/compose/hooks/use-draft-lifecycle.ts`,
    "const AUTOSAVE_MS = 2000;",
    "const AUTOSAVE_MS = 20000;",
  ],
  [
    "reply reference",
    "carries quoted original|keyboard-only",
    shared,
    "          message,",
    '          message: { ...message, inReplyTo: undefined, mode: "new" },',
  ],
  [
    "attachment reminder",
    "attachment reminder blocks",
    `${renderer}features/compose/send.ts`,
    '!confirmed.includes("attachment") &&',
    'false && !confirmed.includes("attachment") &&',
  ],
  [
    "server search",
    "Gmail operators|server search fallback",
    shared,
    "m.reading.searchServer(query)",
    "Effect.succeed({ threads: [], truncated: false, errors: [] })",
  ],
  [
    "recovery",
    "draft recovery",
    shared,
    "m.compose.recoverDraft(id, action, draft)",
    "m.compose.openDraft(id)",
  ],
  [
    "AI network",
    "AI disabled",
    shared,
    "AiSettings: () => m.ai.aiSettings,",
    'AiSettings: () => m.ai.aiSettings.pipe(Effect.tap(() => Effect.promise(() => fetch("https://ai.invalid/disabled")))),',
  ],
  [
    "proposals",
    "proposals approve",
    shared,
    'm.proposals.decideProposal(id, approve, "app")',
    "Effect.void",
  ],
  [
    "notification click",
    "notification click",
    `${renderer}app/use-native-menu-bridge.ts`,
    "navigation.openLink(event.href);",
    "void event.href;",
  ],
];
/** Cases whose anchor text is no longer in its file. Every anchor is checked before any case runs. */
export function missingAnchors() {
  return cases
    .filter(
      ([, , relative, before]) =>
        !readFileSync(resolve(desktop, relative), "utf8").includes(before),
    )
    .map(([name, , relative, before]) => `${name} (${relative}): ${before}`);
}

function run() {
  const missing = missingAnchors();
  if (missing.length)
    throw new Error(`Mutation anchors missing; update the cases first:\n${missing.join("\n")}`);
  if (process.argv.includes("--check-anchors")) {
    process.stdout.write(`All ${cases.length} mutation anchors found.\n`);
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "openmail-mutations-"));
  const killed = new Set();
  try {
    for (const [name, pattern, relative, before, after] of cases) {
      const path = resolve(desktop, relative);
      const original = readFileSync(path, "utf8");
      const report = join(directory, "report.json");
      rmSync(report, { force: true });
      const changed = original.replace(before, after);
      writeFileSync(
        path,
        relative === shared && !original.includes('import { Effect } from "effect";')
          ? `import { Effect } from "effect";\n${changed}`
          : changed,
      );
      try {
        const result = spawnSync(
          "pnpm",
          [
            "exec",
            "vitest",
            "run",
            "--config",
            "vitest.e2e.config.ts",
            "-t",
            pattern,
            "--reporter=json",
            `--outputFile=${report}`,
          ],
          {
            cwd: desktop,
            env: { ...process.env, OPENMAIL_LOW_MEMORY_TESTS: "1" },
            encoding: "utf8",
            // Each run loads the whole e2e suite before -t filters it: about 50 s on a laptop.
            timeout: 240_000,
          },
        );
        if (result.error) throw result.error;
        const data = JSON.parse(readFileSync(report, "utf8"));
        const selected = data.testResults
          .flatMap((file) => file.assertionResults)
          .filter((test) => test.status !== "pending" && test.status !== "skipped");
        if (
          result.status === 0 ||
          selected.length === 0 ||
          selected.some((test) => test.status !== "failed")
        ) {
          throw new Error(
            `Mutation survived or could not exercise its tests: ${name}\n${JSON.stringify(selected.map((test) => ({ name: test.fullName, status: test.status })))}\n${result.stdout}\n${result.stderr}`,
          );
        }
        for (const test of selected) killed.add(test.fullName);
        process.stdout.write(`${name}: ${selected.length} test(s) failed as required\n`);
      } finally {
        writeFileSync(path, original);
      }
    }
    if (killed.size !== 42)
      throw new Error(`Expected all 42 covered flows to fail at least once; got ${killed.size}`);
    process.stdout.write(`Verified ${killed.size} flows; all temporary changes restored.\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) run();
