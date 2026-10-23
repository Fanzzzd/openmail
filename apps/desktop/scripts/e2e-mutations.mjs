import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Each case changes behavior and names the tests that must fail: `[name, titles, file, before,
// after]`. A title is a test's title as its source writes it, with `%s` or `$field` where a
// parameterized test puts its value. Always restore the working file.
const desktop = fileURLToPath(new URL("..", import.meta.url));
const e2e = resolve(desktop, "src/renderer/src/e2e");
const shared = "src/shared/mailbox-handlers.ts";
const renderer = "src/renderer/src/";
/** @type {ReadonlyArray<readonly [string, readonly string[], string, string, string]>} */
export const cases = [
  [
    "HTML draft import",
    [
      "%s server HTML opens, saves untouched, then edits one word without losing other formatting",
      "%s keeps unsupported tables and CSS until an explicit body edit",
      "$provider: $client opens in the rich composer, saves and edits without losing content",
      "$client opens in the rich composer and preserves quotes and CID images after an edit",
    ],
    `${renderer}features/compose/draft.ts`,
    "body: outgoingComposeBody(m),",
    'body: { kind: "plain", text: m.text },',
  ],
  [
    "draft transport preview",
    [
      "preserved draft preview matches transport and excludes every hidden-content probe",
      "forward preview and send exclude every hidden-content probe",
    ],
    `${renderer}features/compose/compose-preview.ts`,
    "return prepareMessageHtml(transport, { inline }).html;",
    'return "<p>SECRET</p>";',
  ],
  [
    "unsaved draft status",
    [
      "opening and closing a never-saved composer emits no failed RPC or message lookup for its draft id",
    ],
    shared,
    "DraftStatus: ({ id }) => m.compose.draftStatus(id),",
    "DraftStatus: ({ id }) => m.compose.openDraft(id),",
  ],
  [
    "sync",
    ["first sync renders provider messages through RPC and persists the inbox"],
    shared,
    "m.sync.sync().pipe(Effect.catchDefect",
    "Effect.succeed([]).pipe(Effect.catchDefect",
  ],
  [
    "read delay",
    ["opening a thread delays mark read and switching cancels the previous timer"],
    `${renderer}app/use-mail-selection.ts`,
    "markReadAfter(prefs.markReadDelay",
    "markReadAfter(0",
  ],
  [
    "narrow Back after opening",
    [
      "Back from a narrow reader selects and focuses the conversation it opened, by click or by Enter",
    ],
    `${renderer}routes/router.ts`,
    "    router.history.flush();\n",
    "",
  ],
  [
    "Back after a quick folder switch",
    ["Back after a quick folder switch returns to the thread just selected, in window history"],
    `${renderer}routes/router.ts`,
    "    router.history.flush();\n",
    "",
  ],
  [
    "recipient suggestion removal key",
    ["Shift-Backspace edits the text; forward Delete stops suggesting, shows it and can be undone"],
    `${renderer}features/compose/components/RecipientField.tsx`,
    "highlightedAddress && removesSuggestion(e, e.currentTarget)",
    'highlightedAddress && e.shiftKey && (e.key === "Backspace" || e.key === "Delete")',
  ],
  [
    "recipient suggestion undo",
    ["Shift-Backspace edits the text; forward Delete stops suggesting, shows it and can be undone"],
    `${renderer}features/compose/components/RecipientField.tsx`,
    "payload: { address: address.address, hidden: false }",
    "payload: { address: address.address, hidden: true }",
  ],
  [
    "stale rows while a query loads",
    ["the previous list's rows are dimmed and inert while a search loads"],
    `${renderer}features/mail-list/MessageList.tsx`,
    "inert={stale}",
    "inert={false}",
  ],
  [
    "narrow list landmark",
    [
      "a narrow window's list and reader are each the main landmark with an h1; wide stays one main",
    ],
    `${renderer}app/MailListPane.tsx`,
    "landmark={narrow}",
    "landmark={false}",
  ],
  [
    "narrow reader heading",
    [
      "a narrow window's list and reader are each the main landmark with an h1; wide stays one main",
    ],
    `${renderer}features/reader/Reader.tsx`,
    "subjectLevel={landmark ? 1 : 2}",
    "subjectLevel={2}",
  ],
  [
    "organization",
    [
      "Gmail labels remain additive and Cmd+Z removes only the added label",
      "%s moves to one folder instead of applying Gmail labels, then undoes",
      "offline archive survives conflicting server pull and retries the queue once",
      "provider latency leaves the local archive and selection responsive",
    ],
    shared,
    "m.organize.modifyWithUndo(threads, op, flat)",
    "m.organize.modifyWithUndo([], op, flat)",
  ],
  [
    "snooze",
    ["snooze advances selection and Cmd+Z restores the inbox and reminder"],
    shared,
    "m.organize.snoozeWithUndo(threads, due)",
    "m.organize.snoozeWithUndo([], due)",
  ],
  [
    "autosave",
    ["new compose autosaves, holds send, Cmd+Z reopens it, and the second send delivers once"],
    `${renderer}features/compose/hooks/use-draft-lifecycle.ts`,
    "const AUTOSAVE_MS = 2000;",
    "const AUTOSAVE_MS = 20000;",
  ],
  [
    "reply reference",
    [
      "%s carries quoted original, signature and recipients through send",
      "keyboard-only list to reader to reply to send keeps the selected original",
    ],
    shared,
    "          message,",
    '          message: { ...message, inReplyTo: undefined, mode: "new" },',
  ],
  [
    "attachment reminder",
    ["attachment reminder blocks send until the user explicitly confirms"],
    `${renderer}features/compose/send.ts`,
    '!confirmed.includes("attachment") &&',
    'false && !confirmed.includes("attachment") &&',
  ],
  [
    "server search",
    [
      "Gmail operators search the server and persist an uncached match",
      "server search fallback names the skipped operators and keeps local filtering",
    ],
    shared,
    "m.reading.searchServer(query)",
    "Effect.succeed({ threads: [], truncated: false, errors: [] })",
  ],
  [
    "recovery",
    ["draft recovery %s updates the saved edits and provider sync state"],
    shared,
    "m.compose.recoverDraft(id, action, draft)",
    "m.compose.openDraft(id)",
  ],
  [
    "AI network",
    ["AI disabled keeps reading and composing off the network"],
    shared,
    "AiSettings: () => m.ai.aiSettings,",
    'AiSettings: () => m.ai.aiSettings.pipe(Effect.tap(() => Effect.promise(() => fetch("https://ai.invalid/disabled")))),',
  ],
  [
    "proposals",
    ["proposals approve only the chosen change and rejection never pushes"],
    shared,
    'm.proposals.decideProposal(id, approve, "app")',
    "Effect.void",
  ],
  [
    "search results from the stale list",
    [
      "Down right after typing a search with no results waits for it and stays in the field",
      "Down right after typing enters the new results once they arrive",
      "Enter twice while the search loads enters its results once they arrive",
      "an operator with Down selects the first row of its own results",
      "Down keeps an already selected result selected and focuses it",
      "Down from a field holding a chip enters that search's results",
    ],
    `${renderer}features/search/results-entry.ts`,
    '  if (list.loading) return { kind: "wait" };',
    "",
  ],
  [
    "search results with no rows",
    ["Down right after typing a search with no results waits for it and stays in the field"],
    `${renderer}features/search/results-entry.ts`,
    'if (!first) return list.searchingServer ? { kind: "wait" } : { kind: "drop" };',
    'if (!first) return { kind: "enter", id: "", kept: false };',
  ],
  [
    "search results request kept after the text changes or focus leaves",
    [
      "editing the search after Down drops the request; the next Down enters the new results",
      "Escape after Down while the search loads returns to the mailbox without opening anything",
    ],
    `${renderer}features/search/results-entry.ts`,
    "if (now.search !== request.search || now.active !== request.from)",
    "if (false)",
  ],
  [
    "search results request kept after the field loses focus",
    ["leaving the search field after Down drops the request, even when focus comes back"],
    `${renderer}app/use-mail-selection.ts`,
    '    field.addEventListener("focusout", leave);',
    "",
  ],
  [
    "notification click",
    [
      "notification click event opens the requested thread and clears an active search",
      "notification click followed by immediate search clears hidden selection before keyboard actions",
    ],
    `${renderer}app/use-native-menu-bridge.ts`,
    "navigation.openLink(event.href);",
    "void event.href;",
  ],
  [
    "narrow Back after a wide pick",
    ["Back from a narrow reader lands on the conversation picked while the window was wide"],
    `${renderer}app/use-pane-navigation.ts`,
    '    if (layout.mode !== "narrow") {\n      readerEntry.current = null;\n',
    '    if (layout.mode !== "narrow") {\n',
  ],
  [
    "narrow Forward onto the reader",
    ["Cmd+] after Cmd+[ in a narrow window opens the reader again"],
    `${renderer}app/use-pane-navigation.ts`,
    '        if (move === "forward" && left && history.index() === left.index) {',
    "        if (false) {",
  ],
  [
    "narrow Back focuses a row below the first screen",
    ["Back from a narrow reader focuses a row that was below the first screen"],
    `${renderer}app/use-mail-selection.ts`,
    "if (focus && !row && frames++ < FOCUS_ROW_FRAMES) requestAnimationFrame(attempt);",
    "if (false) requestAnimationFrame(attempt);",
  ],
  [
    "recipient text kept on the way to Undo",
    ["Tab to Undo after hiding the last suggestion keeps the typed text, and says where Undo is"],
    `${renderer}features/compose/components/RecipientField.tsx`,
    "            if (event.relatedTarget === undoRef.current) return;\n",
    "",
  ],
  [
    "stale rows stay dim between keystrokes",
    ["rows stay dim between keystrokes while each query loads, and brighten once typing pauses"],
    `${renderer}features/mail-list/MessageList.tsx`,
    "stale ? DIM_AFTER_MS : BRIGHTEN_AFTER_MS",
    "stale ? DIM_AFTER_MS : 0",
  ],
  [
    "collapsed message heading name",
    ["a collapsed message's heading is named by sender and time, with its snippet as description"],
    `${renderer}features/reader/ThreadMessage.tsx`,
    "        aria-label={t`${sender}, ${sent}`}\n        aria-describedby={snippetId}\n",
    "",
  ],
  [
    "recent search removal announced",
    ["Fn-Delete on a recent search removes it and says so"],
    `${renderer}features/search/SearchField.tsx`,
    "    setAnnouncement(t`Removed ${query} from recent searches`);\n",
    "",
  ],
  [
    "search popup leaves the window exposed",
    ["the search popup leaves the rest of the window exposed to screen readers"],
    `${renderer}features/search/SearchField.tsx`,
    "  useKeepPageExposed(shown);\n",
    "",
  ],
  [
    "search from a route reads as submitted",
    [
      "Back from a narrow reader to a search whose last word is one character shows the same results",
      "a search link whose last word is one character runs it whole",
    ],
    `${renderer}state/ui.ts`,
    ": routeSearchText(q);",
    ": q;",
  ],
  [
    "widening steps back over an unchanged reader entry",
    [
      "passing through the narrow layout leaves no Back step that changes nothing",
      "widening after a narrow pick leaves no Back step that changes nothing",
    ],
    `${renderer}app/use-pane-navigation.ts`,
    "        steppedOver.current = entry;\n        history.back();\n",
    "        steppedOver.current = entry;\n",
  ],
  [
    "widening ignores the message the narrow reader picked",
    ["widening after a narrow pick leaves no Back step that changes nothing"],
    `${renderer}app/use-pane-navigation.ts`,
    "withoutMessage(registry.get(locationAtom).href) === beforeReader.current",
    "registry.get(locationAtom).href === beforeReader.current",
  ],
  [
    "Forward steps back off the reader entry widening left",
    ["Next view never lands on the reader entry that widening stepped back over"],
    `${renderer}app/use-pane-navigation.ts`,
    '        if (move === "forward" && history.index() === steppedOver.current) {',
    "        if (false) {",
  ],
  [
    "widening restores focus that fell to the page",
    ["widening keeps focus on the reader or the row that had it"],
    `${renderer}app/use-pane-navigation.ts`,
    "      moveFrame.current = null;\n",
    "      moveFrame.current = null;\n      return;\n",
  ],
  [
    "crossing 960 px keeps focus on the element that had it",
    ["crossing 960 px either way keeps focus on the row or the reader that had it"],
    `${renderer}app/use-pane-navigation.ts`,
    "      if (shows(element) && restore(element, restoring)) return;\n",
    "",
  ],
  [
    "a pane move restores focus displaced from a moved host",
    ["crossing 960 px either way keeps focus on the row or the reader that had it"],
    `${renderer}app/use-pane-navigation.ts`,
    "hosts.some((moved) => moved.contains(element))",
    "false",
  ],
  [
    "a pane move forgets focus the person left",
    ["a pane move leaves focus on the page when the person had left the element"],
    `${renderer}app/use-pane-navigation.ts`,
    "        focused.current = { pane: null, element: null };\n",
    "",
  ],
  [
    "sidebar focus moves to the same control in the sidebar shown",
    [
      "focus in the sidebar moves to the same mailbox in the sidebar, rail or drawer that replaces it",
    ],
    `${renderer}app/use-pane-navigation.ts`,
    "      if (restore(sameControl(element), restoring)) return;\n",
    "",
  ],
  [
    "sidebar focus falls back to the open mailbox",
    [
      "focus in the sidebar moves to the same mailbox in the sidebar, rail or drawer that replaces it",
    ],
    `${renderer}app/use-pane-navigation.ts`,
    '      if (pane === "sidebar" && restore(currentMailbox(), restoring)) return;\n',
    "",
  ],
  [
    "the drawer's sidebar is the sidebar pane",
    [
      "focus in the sidebar moves to the same mailbox in the sidebar, rail or drawer that replaces it",
    ],
    `${renderer}app/App.tsx`,
    '          <div data-mail-pane="sidebar" className="contents">',
    '          <div className="contents">',
  ],
  [
    "a restore's own focus keeps the remembered element",
    ["the search field gets focus back when it shows again after the narrow reader stood in"],
    `${renderer}app/use-pane-navigation.ts`,
    '      if (expected === event.target || (expected === "list" && pane === "list")) {',
    "      if (false) {",
  ],
  [
    "a pane move restores focus from the page",
    ["widening a narrow reader through 800 px and 960 px keeps focus on the reader"],
    `${renderer}app/PaneLayout.tsx`,
    "      moved(host);\n",
    "",
  ],
  [
    "the reader takes focus when it becomes the only pane",
    ["the reader takes focus when it becomes the only pane by narrowing or by Back"],
    `${renderer}app/use-pane-navigation.ts`,
    '      if (panes.reader && (pane === "reader" || !panes.list)) restore(readerPane(), restoring);\n      else ',
    "      ",
  ],
  [
    "focusList scrolls to a row outside the list's window",
    ["Back to a list that started over at the top after a mailbox switch scrolls to its row"],
    `${renderer}app/use-mail-selection.ts`,
    "      if (focus && !row) revealRowRef.current?.(focus);\n",
    "",
  ],
  [
    "Home, End and page keys select in the list",
    ["Home, End, Page Up and Page Down move the list's selection and focus"],
    `${renderer}features/mail-list/MessageList.tsx`,
    "                onKeyboardSelect(id);\n",
    "",
  ],
  [
    "pane dividers read their width in pixels",
    ["pane dividers are named and resize their panes with the arrow keys"],
    `${renderer}app/PaneLayout.tsx`,
    "      aria-valuetext={",
    "      data-valuetext={",
  ],
  [
    "hint stays quiet after a recent search removal",
    ["removing the last recent search leaves its announcement the only live change"],
    `${renderer}features/search/SearchField.tsx`,
    "    setQuietHint(true);\n",
    "",
  ],
  [
    "focus in a popup stands for its trigger",
    ["focus in a menu that a pane move closes goes where its trigger's focus would"],
    `${renderer}app/use-pane-navigation.ts`,
    "const trigger = pane === null ? triggerOf(event.target) : null;",
    "const trigger = null;",
  ],
  [
    "account tiles keep their focus key",
    ["focus on an account tile in the drawer moves to the same tile in the docked sidebar"],
    `${renderer}features/sidebar/SidebarItems.tsx`,
    '        data-focus-key={props.item}\n        aria-current={props.active ? "page" : undefined}\n        // One row',
    '        aria-current={props.active ? "page" : undefined}\n        // One row',
  ],
  [
    "input gives a pending list restore up",
    ["a key pressed while a pane move waits for the list keeps the person's focus there"],
    `${renderer}app/use-pane-navigation.ts`,
    "    const input = () => {\n      restoring.current = null;\n    };",
    "    const input = () => {};",
  ],
  [
    "toolbar buttons name their keys",
    ["the thread ends with Reply, Reply all and Forward, and has one menu for the conversation"],
    `${renderer}ui/Tip.tsx`,
    "        aria-keyshortcuts={shortcut?.keys || undefined}\n",
    "",
  ],
  [
    "sent and draft rows name their recipients",
    ["Sent and Drafts rows name the people the mail goes to, and a draft with none says Draft"],
    `${renderer}features/mail-list/MessageRow.tsx`,
    "    if (recipients.length) return { text: t`To: ${to}`, draft: false };\n",
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

/** Titles that no e2e test file writes as a test title, as after a rename. */
export function missingTitles() {
  const sources = readdirSync(e2e)
    .filter((file) => file.endsWith(".test.ts"))
    .map((file) => readFileSync(join(e2e, file), "utf8"));
  return cases.flatMap(([name, titles]) =>
    titles
      .filter((title) => !sources.some((source) => source.includes(JSON.stringify(title))))
      .map((title) => `${name}: ${title}`),
  );
}

/** A title as a pattern for the titles a run reports, its placeholders matching any value. */
const titlePattern = (title) =>
  title
    .split(/(%[sdifjo#%]|\$\w+)/)
    .map((part, index) => (index % 2 ? ".+?" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");

function run() {
  const missing = [...missingAnchors(), ...missingTitles()];
  if (missing.length)
    throw new Error(
      `Mutation anchors or titles missing; update the cases first:\n${missing.join("\n")}`,
    );
  if (process.argv.includes("--check-anchors")) {
    process.stdout.write(`All ${cases.length} mutation anchors and titles found.\n`);
    return;
  }
  // `--case <name>`, repeated, runs only those cases.
  const only = process.argv.flatMap((arg, index, all) =>
    arg === "--case" ? [all[index + 1]] : [],
  );
  const unknown = only.filter((name) => !cases.some(([caseName]) => caseName === name));
  if (unknown.length) throw new Error(`No such mutation case: ${unknown.join(", ")}`);
  const selected = only.length ? cases.filter(([name]) => only.includes(name)) : cases;
  const directory = mkdtempSync(join(tmpdir(), "openmail-mutations-"));
  try {
    for (const entry of selected) {
      const [name, titles] = entry;
      const patterns = titles.map((title) => new RegExp(`^${titlePattern(title)}$`));
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
            titles.map(titlePattern).join("|"),
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
        const ran = data.testResults
          .flatMap((file) => file.assertionResults)
          .filter((test) => test.status !== "pending" && test.status !== "skipped");
        // Every named test ran and failed. Others that -t picked up may fail too, or pass.
        const named = ran.filter((test) => patterns.some((pattern) => pattern.test(test.title)));
        const unmatched = titles.filter(
          (_, index) => !named.some((test) => patterns[index].test(test.title)),
        );
        if (unmatched.length || named.some((test) => test.status !== "failed")) {
          throw new Error(
            `Mutation survived or could not exercise its tests: ${name}\n${JSON.stringify({ unmatched, named: named.map((test) => ({ name: test.fullName, status: test.status })) })}\n${result.stdout}\n${result.stderr}`,
          );
        }
        process.stdout.write(`${name}: ${named.length} named test(s) failed as required\n`);
      } finally {
        for (const [path, original] of originals) writeFileSync(path, original);
      }
    }
    process.stdout.write(`Verified ${selected.length} cases; all temporary changes restored.\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) run();
