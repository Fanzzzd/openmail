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
    "m.sync.sync().pipe(Effect.catchDefect",
    "Effect.succeed([]).pipe(Effect.catchDefect",
  ],
  [
    "read delay",
    "opening a thread",
    `${renderer}app/use-mail-selection.ts`,
    "markReadAfter(prefs.markReadDelay",
    "markReadAfter(0",
  ],
  [
    "narrow Back after opening",
    "Back from a narrow reader selects",
    `${renderer}routes/router.ts`,
    "    router.history.flush();\n",
    "",
  ],
  [
    "Back after a quick folder switch",
    "Back after a quick folder switch",
    `${renderer}routes/router.ts`,
    "    router.history.flush();\n",
    "",
  ],
  [
    "recipient suggestion removal key",
    "Shift-Backspace edits the text",
    `${renderer}features/compose/components/RecipientField.tsx`,
    "highlightedAddress && removesSuggestion(e, e.currentTarget)",
    'highlightedAddress && e.shiftKey && (e.key === "Backspace" || e.key === "Delete")',
  ],
  [
    "recipient suggestion undo",
    "Shift-Backspace edits the text",
    `${renderer}features/compose/components/RecipientField.tsx`,
    "payload: { address: address.address, hidden: false }",
    "payload: { address: address.address, hidden: true }",
  ],
  [
    "stale rows while a query loads",
    "rows are dimmed and inert while a search loads",
    `${renderer}features/mail-list/MessageList.tsx`,
    "inert={stale}",
    "inert={false}",
  ],
  [
    "narrow list landmark",
    "each the main landmark with an h1",
    `${renderer}app/MailListPane.tsx`,
    "landmark={narrow}",
    "landmark={false}",
  ],
  [
    "narrow reader heading",
    "each the main landmark with an h1",
    `${renderer}features/reader/Reader.tsx`,
    "subjectLevel={landmark ? 1 : 2}",
    "subjectLevel={2}",
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
    "search results from the stale list",
    "Down right after typing|Enter twice while the search loads|an operator with Down|Down keeps an already selected result|Down from a field holding a chip",
    `${renderer}features/search/results-entry.ts`,
    '  if (list.loading) return { kind: "wait" };',
    "",
  ],
  [
    "search results with no rows",
    "Down right after typing a search with no results",
    `${renderer}features/search/results-entry.ts`,
    'if (!first) return list.searchingServer ? { kind: "wait" } : { kind: "drop" };',
    'if (!first) return { kind: "enter", id: "", kept: false };',
  ],
  [
    "search results request kept after the text changes or focus leaves",
    "editing the search after Down|Escape after Down while the search loads",
    `${renderer}features/search/results-entry.ts`,
    "if (now.search !== request.search || now.active !== request.from)",
    "if (false)",
  ],
  [
    "search results request kept after the field loses focus",
    "leaving the search field after Down",
    `${renderer}app/use-mail-selection.ts`,
    '    field.addEventListener("focusout", leave);',
    "",
  ],
  [
    "notification click",
    "notification click",
    `${renderer}app/use-native-menu-bridge.ts`,
    "navigation.openLink(event.href);",
    "void event.href;",
  ],
  [
    "narrow Back after a wide pick",
    "lands on the conversation picked while the window was wide",
    `${renderer}app/use-pane-navigation.ts`,
    '    if (layout.mode !== "narrow") {\n      readerEntry.current = null;\n',
    '    if (layout.mode !== "narrow") {\n',
  ],
  [
    "narrow Forward onto the reader",
    "in a narrow window opens the reader again",
    `${renderer}app/use-pane-navigation.ts`,
    '        if (move === "forward" && left && history.index() === left.index) {',
    "        if (false) {",
  ],
  [
    "narrow Back focuses a row below the first screen",
    "focuses a row that was below the first screen",
    `${renderer}app/use-mail-selection.ts`,
    "if (focus && !row && frames++ < FOCUS_ROW_FRAMES) requestAnimationFrame(attempt);",
    "if (false) requestAnimationFrame(attempt);",
  ],
  [
    "recipient text kept on the way to Undo",
    "Tab to Undo after hiding the last suggestion",
    `${renderer}features/compose/components/RecipientField.tsx`,
    "            if (event.relatedTarget === undoRef.current) return;\n",
    "",
  ],
  [
    "stale rows stay dim between keystrokes",
    "rows stay dim between keystrokes",
    `${renderer}features/mail-list/MessageList.tsx`,
    "stale ? DIM_AFTER_MS : BRIGHTEN_AFTER_MS",
    "stale ? DIM_AFTER_MS : 0",
  ],
  [
    "collapsed message heading name",
    "a collapsed message's heading is named by sender and time",
    `${renderer}features/reader/ThreadMessage.tsx`,
    "        aria-label={t`${sender}, ${sent}`}\n        aria-describedby={snippetId}\n",
    "",
  ],
  [
    "recent search removal announced",
    "Fn-Delete on a recent search removes it and says so",
    `${renderer}features/search/SearchField.tsx`,
    "    setAnnouncement(t`Removed ${query} from recent searches`);\n",
    "",
  ],
  [
    "search popup leaves the window exposed",
    "the search popup leaves the rest of the window exposed",
    `${renderer}features/search/SearchField.tsx`,
    "  useKeepPageExposed(shown);\n",
    "",
  ],
  [
    "search from a route reads as submitted",
    "whose last word is one character",
    `${renderer}state/ui.ts`,
    ": routeSearchText(q);",
    ": q;",
  ],
  [
    "widening steps back over an unchanged reader entry",
    "leaves no Back step that changes nothing",
    `${renderer}app/use-pane-navigation.ts`,
    "        steppedOver.current = entry;\n        history.back();\n",
    "        steppedOver.current = entry;\n",
  ],
  [
    "widening ignores the message the narrow reader picked",
    "widening after a narrow pick leaves no Back step",
    `${renderer}app/use-pane-navigation.ts`,
    "withoutMessage(registry.get(locationAtom).href) === beforeReader.current",
    "registry.get(locationAtom).href === beforeReader.current",
  ],
  [
    "Forward steps back off the reader entry widening left",
    "Next view never lands on the reader entry",
    `${renderer}app/use-pane-navigation.ts`,
    '        if (move === "forward" && history.index() === steppedOver.current) {',
    "        if (false) {",
  ],
  [
    "widening restores focus that fell to the page",
    "widening keeps focus on the reader or the row",
    `${renderer}app/use-pane-navigation.ts`,
    "      moveFrame.current = null;\n",
    "      moveFrame.current = null;\n      return;\n",
  ],
  [
    "crossing 960 px keeps focus on the element that had it",
    "crossing 960 px either way keeps focus",
    `${renderer}app/use-pane-navigation.ts`,
    "        element.focus({ preventScroll: true });\n",
    "",
  ],
  [
    "a pane move restores focus from the page",
    "widening a narrow reader through 800 px and 960 px",
    `${renderer}app/PaneLayout.tsx`,
    "      moved();\n",
    "",
  ],
  [
    "the reader takes focus when it becomes the only pane",
    "the reader takes focus when it becomes the only pane",
    `${renderer}app/use-pane-navigation.ts`,
    '      if (panes.reader && (pane === "reader" || !panes.list)) focusReaderNow();\n      else ',
    "      ",
  ],
  [
    "focusList scrolls to a row outside the list's window",
    "started over at the top after a mailbox switch",
    `${renderer}app/use-mail-selection.ts`,
    "      if (focus && !row) revealRowRef.current?.(focus);\n",
    "",
  ],
  [
    "Home, End and page keys select in the list",
    "Home, End, Page Up and Page Down move the list",
    `${renderer}features/mail-list/MessageList.tsx`,
    "                onKeyboardSelect(id);\n",
    "",
  ],
  [
    "pane dividers read their width in pixels",
    "pane dividers are named and resize",
    `${renderer}app/PaneLayout.tsx`,
    "      aria-valuetext={",
    "      data-valuetext={",
  ],
  [
    "hint stays quiet after a recent search removal",
    "leaves its announcement the only live change",
    `${renderer}features/search/SearchField.tsx`,
    "    setQuietHint(true);\n",
    "",
  ],
];
/** More changes a case makes, each `[relative, before, after]` in a file of its own. */
const moreEdits = new Map([
  [
    "search results request kept after the text changes or focus leaves",
    // Escape moves focus to the list, so the field's focusout drops the request too.
    [
      [
        `${renderer}app/use-mail-selection.ts`,
        '    field.addEventListener("focusout", leave);',
        "",
      ],
    ],
  ],
]);
const edits = ([name, , relative, before, after]) => [
  [relative, before, after],
  ...(moreEdits.get(name) ?? []),
];

/** Cases whose anchor text is no longer in its file. Every anchor is checked before any case runs. */
export function missingAnchors() {
  return cases.flatMap((entry) =>
    edits(entry)
      .filter(
        ([relative, before]) => !readFileSync(resolve(desktop, relative), "utf8").includes(before),
      )
      .map(([relative, before]) => `${entry[0]} (${relative}): ${before}`),
  );
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
    for (const entry of cases) {
      const [name, pattern] = entry;
      const originals = new Map();
      const report = join(directory, "report.json");
      rmSync(report, { force: true });
      try {
        for (const [relative, before, after] of edits(entry)) {
          const path = resolve(desktop, relative);
          const original = readFileSync(path, "utf8");
          originals.set(path, original);
          const changed = original.replace(before, after);
          writeFileSync(
            path,
            relative === shared && !original.includes('import { Effect } from "effect";')
              ? `import { Effect } from "effect";\n${changed}`
              : changed,
          );
        }
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
        for (const [path, original] of originals) writeFileSync(path, original);
      }
    }
    if (killed.size !== 75)
      throw new Error(`Expected all 75 covered flows to fail at least once; got ${killed.size}`);
    process.stdout.write(`Verified ${killed.size} flows; all temporary changes restored.\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) run();
