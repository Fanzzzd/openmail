import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Each selected test must fail after an actual behavior change. Always restore the working file.
const desktop = fileURLToPath(new URL("..", import.meta.url));
const shared = "src/shared/mailbox-handlers.ts";
const renderer = "src/renderer/src/";
const cases = [
  [
    "unsaved draft status",
    "never-saved composer",
    shared,
    "DraftStatus: ({ id }) => m.draftStatus(id),",
    "DraftStatus: ({ id }) => m.openDraft(id),",
  ],
  ["sync", "first sync", shared, "Sync: () => m.sync(),", "Sync: () => Effect.succeed([]),"],
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
    "m.modifyWithUndo(threads, op, flat)",
    "m.modifyWithUndo([], op, flat)",
  ],
  [
    "snooze",
    "snooze advances",
    shared,
    "m.snoozeWithUndo(threads, due)",
    "m.snoozeWithUndo([], due)",
  ],
  [
    "autosave",
    "new compose autosaves",
    `${renderer}compose/use-draft-lifecycle.ts`,
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
    `${renderer}send.ts`,
    '!confirmed.includes("attachment") &&',
    'false && !confirmed.includes("attachment") &&',
  ],
  [
    "server search",
    "Gmail operators|server search fallback",
    shared,
    "m.searchServer(query)",
    "Effect.succeed({ threads: [], truncated: false, errors: [] })",
  ],
  ["recovery", "draft recovery", shared, "m.recoverDraft(id, action, draft)", "m.openDraft(id)"],
  [
    "AI network",
    "AI disabled",
    shared,
    "AiSettings: () => m.aiSettings,",
    'AiSettings: () => m.aiSettings.pipe(Effect.tap(() => Effect.promise(() => fetch("https://ai.invalid/disabled")))),',
  ],
  ["proposals", "proposals approve", shared, 'm.decideProposal(id, approve, "app")', "Effect.void"],
  [
    "notification click",
    "notification click",
    `${renderer}app/use-native-menu-bridge.ts`,
    "else openExternal(event.id);",
    "else navigation.setSelectedId(null);",
  ],
];
const directory = mkdtempSync(join(tmpdir(), "openmail-mutations-"));
const killed = new Set();
try {
  for (const [name, pattern, relative, before, after] of cases) {
    const path = resolve(desktop, relative);
    const original = readFileSync(path, "utf8");
    if (!original.includes(before)) throw new Error(`Mutation anchor missing: ${name}`);
    const report = join(directory, "report.json");
    rmSync(report, { force: true });
    const changed = original.replace(before, after);
    writeFileSync(
      path,
      relative === shared ? `import { Effect } from "effect";\n${changed}` : changed,
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
          timeout: 45_000,
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
  if (killed.size !== 25)
    throw new Error(`Expected all 25 covered flows to fail at least once; got ${killed.size}`);
  process.stdout.write(`Verified ${killed.size} flows; all temporary changes restored.\n`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
