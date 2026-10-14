# Testing

The automated tests cover the core, CLI, desktop and mobile mail flows. They use a fake provider and Model, temporary SQLite or in-memory databases, the DOM and mocks of native services. The full mail flow tests also run in jsdom. They do not start Electron and do not read a real mailbox or address book. Acceptance with real accounts, system permissions and signed builds is in the [roadmap](roadmap.md#待用户完成).

## Repository checks

Run from the repo root:

```sh
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
pnpm exec oxlint
pnpm exec oxfmt --check .
```

`pnpm build` builds core, the CLI, the desktop app and the docs site, compiles the mobile locale catalogs and type-checks the mobile app. To skip the docs site and mobile, run `pnpm build --filter=@openmail/desktop...`, which builds the desktop app and the packages it depends on. `pnpm test` includes the desktop full mail flows, the desktop and mobile Lingui catalog sync and missing-translation checks, and the desktop glossary and ICU checks. Run `pnpm check-types` for the remaining type checks. The commit requirements are in [AGENTS.md](../AGENTS.md).

[repo-paths.test.ts](../apps/docs/scripts/repo-paths.test.ts) checks that every repo path named in the links, code spans and commands of `docs/` and `CONTRIBUTING.md` exists. Local files that git ignores are exempt. The result depends on files outside apps/docs, so `@openmail/docs#test` skips the turbo cache.

Some desktop tests read build output, such as the web build in `out/web`. Turbo runs the desktop `build` before `@openmail/desktop#test`. When the build hits the cache, that step takes about 0.3 seconds. Run `pnpm build` before you run these tests with vitest directly.

Tests that read source from more than one package live in [scripts/repo-checks](../scripts/repo-checks/src). They check the core import boundary against `.oxlintrc.json`, provider-name comparisons, diagnostic codes on log sites and the Metro resolver. `@openmail/repo-checks#test` lists the trees they read as its turbo inputs. Package tests read their own package, its built dependencies and the root files listed as `$TURBO_ROOT$` inputs of their task in [turbo.json](../turbo.json). For `@openmail/desktop#test` these are `.oxlintrc.json`, `docs/security.md`, `docs/agents.md`, `docs/licenses/`, `THIRD_PARTY_NOTICES.md` and `scripts/check-licenses.mjs`. A test that starts reading another root file must add it there, or turbo replays a stale cached pass. An edit in the desktop app does not rerun the core suite. The CLI tests that run the built `corpus-check` command are in [packages/cli/src/corpus-check.test.ts](../packages/cli/src/corpus-check.test.ts).

`OPENMAIL_LOW_MEMORY_TESTS=1` turns on `packages/core/vitest.low-memory.ts`: one worker, files run in series, and a 60 second timeout for tests and hooks. Core test files share one module graph. Files that call `vi.mock` or `vi.doMock` go into a separate isolated `mocking` project instead. In the shared graph, those files would get the real modules that an earlier file loaded, and the result would depend on file order. Normal runs, and every desktop, mobile and CLI run, isolate files. The full mail flow config has its own single worker and a 20 second timeout, scaled by the multiplier in [Tests under load](#tests-under-load).

## Dependency audit

`pnpm audit:prod` runs [audit-prod.mjs](../scripts/audit-prod.mjs). It runs `pnpm audit --prod` over the whole lockfile and sorts each finding by where its dependency path starts. A vulnerability reached through the desktop app, the CLI, core or the root fails the command with exit code 1. A vulnerability reached only through the mobile app or the docs site prints as a warning and does not fail the command. Mobile findings get fixed with Expo SDK upgrades, and the docs site is a static export. `pnpm audit` has no `--filter`, so the script does the sorting.

The audit needs the npm registry, so it is not part of the offline checks above. The [Audit workflow](../.github/workflows/audit.yml) runs every Monday at 06:00 UTC and can also be started by hand. On 2026-10-13 it reported 4 warnings, all from mobile (expo and react-native's metro): node-forge and braces at high, uuid and decode-uri-component at moderate. source-map-js used to arrive through core's css-tree; the lockfile now has 1.2.2.

## Tests under load

- Do not synchronize with sleep. Advance time with fake timers, and wait for explicit events with an Effect Deferred.
- Assert wall-clock budgets only under `OPENMAIL_PERF=1`, with `pnpm --filter @openmail/core test:perf`.
- Multiply every limit that must use real time by `testTimeScale` from [test-time.ts](../packages/core/test-support/test-time.ts). That covers `vi.waitFor`, `expect.poll`, waiting for a child process, the linear-time bounds in fuzz tests and the per-test timeout of the full flows. `testTimeScale` is 3 when `CI` is set, and `OPENMAIL_TEST_TIME_SCALE` overrides it. Their own limit is only 1 second. In core, pass `waitLimit` to `vi.waitFor` and `expect.poll`. Desktop and CLI tests get it as the default: [wait-defaults.ts](../packages/core/test-support/wait-defaults.ts) gives `vi.waitFor` and `vi.waitUntil` calls without a `timeout` the scaled limit, `pollDefaults` does the same for `expect.poll` in their Vitest configs, and the desktop [setup file](../apps/desktop/src/renderer/src/test-support/wait-defaults.ts) sets Testing Library's `asyncUtilTimeout`, which `waitFor` and `findBy*` use. A check that something does not happen has no event to wait for; keep its real-time window short and multiply it by `scaledMs`. Virtual time from TestClock and fake timers is not scaled.
- Create database fixtures as independent copies with [migrated-database.ts](../packages/core/test-support/migrated-database.ts).
- Compare large files byte for byte with [file-bytes.ts](../packages/core/test-support/file-bytes.ts).
- Starting a worker or CLI process costs a few hundred milliseconds each time. Reuse the worker within a file, as `corpus-check.test.ts` does. Wait on independent child-process tests in parallel with `test.concurrent`. Each test should wait for at most one process start in series. Put setup starts in `beforeAll`.

To check, run the following commands repeatedly and in parallel from `packages/core`, while 4 to 6 `yes > /dev/null` processes run. Stop the load processes you started when you finish:

```sh
pnpm exec vitest run --maxWorkers=1 \
  src/providers/outlook/ \
  src/platform/react-native/database-recovery.test.ts \
  src/platform/node/corpus-check.test.ts src/platform/node/visible-text-cost.test.ts
```

For desktop, run `pnpm exec vitest run --maxWorkers=1 src/main/files/attachment-actions.test.ts` from `apps/desktop`.

Every Vitest project gets its own temporary directory through `packages/core/test-support/temp-directory.ts`. At start-up it removes only `openmail-tests-*` directories that this helper created and that are older than 24 hours, and it does not follow symlinks. Tests must still close databases and delete fixtures with an Effect scope, `afterEach` or `finally`. The global teardown reports leftover `openmail-*` and `om-*` fixtures and deletes the whole directory, so a failed test does not leave a large database behind either. Performance fixtures are not cached between runs. search-profile keeps only a database you name explicitly and deletes the default one in `finally`. corpus-check registers its persistent explain key during the test and deletes it afterwards.

## What the tests cover

| Path                                                                                | Coverage and limits                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/**/*.test.ts`                                                    | Sync, the offline queue, drafts, undo, FTS, search, calendar and contacts, AI consent and the model protocol. Provider networking is fake.                   |
| `packages/core/src/platform/node/node-mailbox.test.ts`                              | A real NodeMailbox, a temporary database, MIME, the attachment cache, PDF and image input and the rejection paths. IMAP transport and passwords are fake.    |
| `scripts/repo-checks/src/platform-imports.test.ts`                                  | Imports in non-Node sources, implicit globals and the portable local dependency graph. It does not replace Metro or device checks.                           |
| `packages/cli/src/mcp-server.test.ts`                                               | The MCP handshake, tool schemas, identity, paging and budgets, and write permissions.                                                                        |
| `apps/desktop/src/main/**/*.test.ts`, renderer tests                                | Window and menu handlers, RPC, keyboard, selection and focus, accessibility, the editor and AI diffs. Test scaffolding stands in for the OS.                 |
| `packages/core/src/platform/react-native/*.test.ts`, `apps/mobile/src/**/*.test.ts` | The Node SQLite shim, OAuth and MIME adapters, and Expo service mocks. They do not prove JSI, device locking, WAL, secure storage or real browser callbacks. |

[performance-plans.test.ts](../packages/core/src/platform/node/performance-plans.test.ts) checks the indexes of the real Store SQL in one place. A sync health case with 120 messages covers paging wraparound and Unicode ID order; it is a normal test. The 100,000-message [performance-large.test.ts](../packages/core/src/platform/node/performance-large.test.ts) is excluded by default and runs only with `pnpm test:perf`. Its commands, reports, latency budgets and the write and disk cost of migration 35 are maintained only in [performance](performance.md).

The fake Apple Contacts helper, its self-check and the limits of testing on a real Mac are maintained only in [Apple Contacts](apple-contacts.md#验证边界). Performance data, query plans and reproduction scripts are maintained only in [performance](performance.md).

`models.integration.test.ts` is skipped by default. It runs on-device inference only when `OPENMAIL_TEST_MODELS=1` is set and the E5 and MobileCLIP files that `spikes/media/models/` asks for are present. Regular regressions for third-party AI use a fake Model and fetch, and make no real API requests.

The CLI sync progress and SIGINT/SIGTERM exit tests are in `packages/cli/src/sync-progress.test.ts`. They use only a fake provider and an in-memory database. The test for interrupting a keychain wait is in `packages/core/src/platform/node/secrets.test.ts`. It replaces the native keyring and never touches system credentials. The CLI prints a prompt before it reads credentials, and a credential wait during Layer initialization can also be interrupted. The real macOS permission prompt still needs a manual check.

## Outbound operations and sending regressions

The [outbound rules](sync-correctness.md#出站操作队列) are tested with a fake provider, protocol responses and temporary SQLite, plus a local fake server for the SMTP stage. The tests send nothing to real accounts, do not start Electron and do not replace acceptance of native mobile transport.

- [op-queue.test.ts](../packages/core/src/mailbox/op-queue.test.ts): backoff, expiry, lost claims, copy progress, remap failures, draft cleanup and resending only to rejected addresses.
- [Node IMAP regressions](../packages/core/src/platform/node/imap-opqueue.test.ts) and [mobile IMAP regressions](../packages/core/src/platform/react-native/imap.test.ts): copy recovery, a missing UID or Message-ID, rejected flags, special folders, the SMTP stage and failures to save to Sent.
- [Outlook regressions](../packages/core/src/providers/outlook/outlook-errors.test.ts): permanent write rejections and their short reasons.
- [Desktop failure notice](../apps/desktop/src/renderer/src/features/sync-status/failed-op-notice.test.ts) and [mobile failure notice](../apps/mobile/src/failed-op-notice.test.ts): category titles, operation and message details, dismissing the notice and the entry point to resend to rejected addresses. Translations are checked by the usual repo commands.

Offline retry tests advance TestClock or a virtual Date and push only after retry_at, so they do not turn an immediate retry into a requirement.

## Full mail flows

To run only the full mail flows:

```sh
pnpm --filter @openmail/core build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/desktop exec vitest run --config vitest.e2e.config.ts
```

`apps/desktop/src/renderer/src/e2e/flows.test.ts` renders the real App with jsdom and Testing Library. It calls the real Mailbox through the same JSON RPC that preload uses and through `shared/mailbox-handlers.ts`. `harness.ts` creates a temporary `node:sqlite` database for each test and reuses the Gmail, Outlook and IMAP fakes. Test scaffolding provides desktop capabilities such as windows and the clipboard. Notification clicks enter the desktop event stream from the core notification queue.

The main flows cover first sync, delayed mark-as-read, bulk and single-message undo, draft autosave, undo send, reply and forward, the attachment reminder, server search, offline retry, draft recovery, AI turned off, proposal approval, notification clicks and keyboard actions. Run time depends on the machine. The timeouts in the run config say nothing about product response time.

To extend the flows, add a test in the same file and configure mail, providers and preferences through `flow()`. Trigger behavior through UI actions, and assert both the `server` call log and the `store` state.

- `eventually()` waits for RPC and rendering. It fails only after the DOM and RPC have been unchanged for 2.5 seconds (times `testTimeScale`), and it waits no more than three times that in total.
- Dialog modules declared with `lazyDialog` finish loading before `flow()` returns, so opening a dialog no longer waits for a module import.
- `advance()` moves the autosave, mark-as-read and undo timers forward.
- `server.failNext` injects one failure. `beforePush` injects a lasting failure or blocks on a Deferred.
- `holdLists()` blocks list RPCs so you can test navigation and search interleaving.
- `afterEach` closes the Registry, RPC and Mailbox and deletes the temporary database.

Sync replay regressions are in `packages/core/src/mailbox/pending-pull.test.ts`. They cover snooze, wake-up, flag updates and the queue index for all three providers.

Check that each flow catches faults:

```sh
node apps/desktop/scripts/e2e-mutations.mjs
```

The script temporarily changes behavior, one case at a time, requires every selected test to fail, and restores the file after each round. It covers the main flows and related regressions. When you add a flow, add its fault cases to the script. Afterwards run the normal tests and the repo checks.

Regressions for the reset deletion guard are in [sync-reset.test.ts](../packages/core/src/sync/sync-reset.test.ts) and [sync-reset-imap.test.ts](../packages/core/src/sync/sync-reset-imap.test.ts). They cover keeping cached mail outside the window, failed existence checks and persistent re-verification, IMAP UID reuse, and the Prefer page size for the initial, 410 restart, next-page and incremental Outlook delta requests. The rules are maintained only in [sync correctness](sync-correctness.md#重置删除保护).

[sync-stale.test.ts](../packages/core/src/sync/sync-stale.test.ts) checks the per-account scan budget, the hourly cooldown and re-verification after restart, the unavailable count, orphaned remote drafts, and the guard for changes still waiting to push. [sync-reset.test.ts](../packages/core/src/sync/sync-reset.test.ts) and [outlook-sync-health.test.ts](../packages/core/src/providers/outlook/outlook-sync-health.test.ts) check that Outlook conflicts are queued durably before the cursor is saved.

[imap.test.ts](../packages/core/src/providers/imap/imap.test.ts), [sync-reset.test.ts](../packages/core/src/sync/sync-reset.test.ts) and [sync-reset-imap.test.ts](../packages/core/src/sync/sync-reset-imap.test.ts) cover telling a SEARCH failure from an empty set, reset verification with small counts and empty lists, missed folders and invalid UID identity. [outlook-sync-health.test.ts](../packages/core/src/providers/outlook/outlook-sync-health.test.ts) and [provider-calendar.test.ts](../packages/core/src/calendar/provider-calendar.test.ts) check Graph key-segment paging, rejection of foreign domains, nested contact folders, deduplication and the People limit.

[provider-retry.test.ts](../packages/core/src/providers/provider-retry.test.ts), [gmail-send.test.ts](../packages/core/src/providers/gmail/gmail-send.test.ts), [gmail-labels.test.ts](../packages/core/src/providers/gmail/gmail-labels.test.ts), [outlook-draft-recovery.test.ts](../packages/core/src/providers/outlook/outlook-draft-recovery.test.ts) and [outlook-draft-retry.test.ts](../packages/core/src/providers/outlook/outlook-draft-retry.test.ts) cover single submission of non-idempotent writes, reconciliation after a lost response, keeping draft IDs, attachment paging, changeKey conflicts and Trash compensation. [undo-send-and-draft-create.test.ts](../packages/core/src/mailbox/undo-send-and-draft-create.test.ts) and [mobile-outbox.test.ts](../packages/core/src/mailbox/mobile-outbox.test.ts) check the creation log, the send-claim transaction, retries after a definite failure, a disconnected renderer and reopening the database. They also cover late draft callbacks after a merge, stale claims, ID remapping and the partial-rejection guard. On desktop, [renderer-models.test.ts](../apps/desktop/src/renderer/src/app/renderer-models.test.ts) checks the core RPC for undo. The behavior rules are maintained only in [sync correctness](sync-correctness.md#草稿与其他写入). A normal low-memory test run covers all of these without starting Electron.

## Parser fuzzing and accessibility

The parser property tests use fast-check with fixed seeds and a corpus of malicious input. They cover MIME, TNEF and legacy encodings, HTML sanitizing and reparsing, visible text, authentication headers, URLs, search, calendar, chunked IMAP/SMTP streams and attachment filenames. The tests check for bounded output, idempotence, protocol framing and the absence of active content after sanitizing. They cannot prove that every malicious input is safe. The entry points are core [parser-fuzz.test.ts](../packages/core/src/reader/parser-fuzz.test.ts), [parser-fuzz-corpus.ts](../packages/core/src/reader/parser-fuzz-corpus.ts) and [mail-socket-fuzz.test.ts](../packages/core/src/platform/mail-socket-fuzz.test.ts), and on desktop [reader-html-fuzz.test.ts](../apps/desktop/src/renderer/src/features/reader/frame/reader-html-fuzz.test.ts) and the [attachment filename test](../apps/desktop/src/main/files/attachment-filenames-fuzz.test.ts).

To run only the fuzz tests:

```sh
pnpm --filter @openmail/core exec vitest run fuzz
pnpm --filter @openmail/desktop exec vitest run fuzz
```

Each test keeps its own fixed seed and run count. `OPENMAIL_LOW_MEMORY_TESTS=1` lowers the run count of some property tests. When you investigate a fast-check failure, keep the seed, path and minimal counterexample from the output, and replay them with that test's parameters.

The `accessibility-*.test.ts` files in [tests](../apps/desktop/src/renderer/src/tests/) run axe on the main window, settings, the composer, the reader and confirmation dialogs. Serious and critical findings must be zero. Moderate findings must match the [allowlist](../apps/desktop/src/renderer/src/test-support/accessibility-fixtures.ts) exactly, with a reason for each entry; the allowlist is currently empty. jsdom does no layout or canvas contrast checks, so axe's color-contrast rule is off. [accessibility-theme.test.ts](../apps/desktop/src/renderer/src/tests/accessibility-theme.test.ts) checks theme token contrast, focus and reduced motion separately, and there are CSS and language regressions too. DOM interaction tests cover keyboard paths, focus restoration, control names and live regions. They do not replace checks with VoiceOver or gestures on a real device.

```sh
pnpm --filter @openmail/desktop exec vitest run accessibility
```

## Desktop production build smoke test

After building, run from the repo root:

```sh
pnpm build
node apps/desktop/scripts/smoke.mjs --db /path/to/mail.db
```

The script starts the Electron production build and, over a local CDP connection, checks the main window, the first cached conversation, the composer, Settings and the sync health report. It sends no mail. The implementation is in [smoke.mjs](../apps/desktop/scripts/smoke.mjs), [smoke-ui.mjs](../apps/desktop/scripts/smoke-ui.mjs) and core [smoke.ts](../packages/core/src/platform/node/smoke.ts).

Before you pass `--db`, close every process that writes to the original database. The script copies only the database, its WAL if there is one, and `config.json` from the same directory. It stops if a file changes during the copy. It opens only the temporary copy and migrates it to the current version. The copy forces manual mark-as-read and the English UI, turns off the first-run Profiles suggestion, sets every swipe action to none and makes the Delete key ask first. The original files do not change. The script sets `OPENMAIL_BACKGROUND_WINDOWS=1`, so a development build shows its windows with `showInactive()` and does not take focus. Stray keystrokes and trackpad swipes still go to the app you were using. Packaged builds ignore this variable. Keychain items are not copied; the copy reads secrets and refreshes tokens the usual way. Without `config.json`, the copy may ask you to configure an OAuth client. That does not mean you need to sign in again.

The smoke test is offline by default. It starts with `OPENMAIL_OFFLINE=1`, so every core provider method fails at once without sending a request: sync, server counts in the health check, contacts, token refresh and IMAP connections. The report's `network` is then false, and `syncHealth` has only local counts for each account. Add `--network` to let the copy connect to the real providers. Offline mode does not block message images that the reader loads under the remote-image setting.

`--db` is optional; without it the script uses an empty temporary database. `--timeout` is the total wait in milliseconds, 180000 by default. `--port` sets the local CDP port, chosen automatically by default. `--keep` keeps the temporary database and diagnostics files and prints their `directory` in the report; by default they are deleted. The script starts the app with `OPENMAIL_READ_ONLY=1` and a temporary `OPENMAIL_HOME`, and checks Electron's `user-data-dir`. A read-only session still allows local writes and network reads. The exact limits are maintained only in [architecture](architecture.md#read-only-session).

JSON goes to stdout. Steps and preview logs go to stderr:

| Field                                          | Meaning                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readOnly`, `network`, `copiedDatabase`        | Whether the read-only session is on, whether provider calls are allowed (`--network`), and whether a copy of a database was provided.                                                       |
| `steps`                                        | Each step as passed or skipped, with the reason for a skip. Without a cached Inbox conversation the reader step is skipped; without an account the composer and Settings steps are skipped. |
| `syncHealth`                                   | The redacted sync health report for each account. Empty without accounts. Fields and checks are in [sync correctness](sync-correctness.md#同步健康检查).                                    |
| `consoleErrors`, `exceptions`, `ipcRejections` | Renderer errors, exceptions and RPC rejections. Normal aborts do not count as rejections.                                                                                                   |
| `failure`                                      | Why the script failed: a step timed out, the preview exited, or something else. `CDP closed` adds whether the renderer crashed and whether the preview process exited. Empty on success.    |

A passed step proves only that the window path it checks works. A passed `sync-health` means the report call finished. You still need to read `syncHealth` for unavailable providers or mismatched counts; those do not fail the script, and the script does not repair sync. Steps skipped on an empty database do not count as mail flow acceptance.

The script ignores only remote image CSP blocks that come from `about:srcdoc` and match the fixed `img-src data: cid:` message. Any other console error, exception, RPC rejection or `failure` sets the exit code to 1. A normal exit and SIGINT, SIGTERM or SIGHUP share an idempotent cleanup that stops the preview and deletes or keeps the copy according to `--keep`. The signal exit codes are 130, 143 and 129, and an exit code that is already set is not overwritten. Regressions are in [smoke.test.ts](../packages/core/src/platform/node/smoke.test.ts), [smoke-cleanup.test.ts](../packages/core/src/platform/node/smoke-cleanup.test.ts), [smoke-ui.test.ts](../apps/desktop/src/renderer/src/tests/smoke-ui.test.ts) and [rpc-key.test.ts](../apps/desktop/src/renderer/src/state/rpc-key.test.ts).

The redacted provider diagnostics format is maintained only in the [security notes](security.md#provider-diagnostics). The smoke test's raw console output, `failure` and stderr are not limited to that field allowlist, so check them before you share them. The automated tests use the DOM, temporary databases and fake providers. They do not run the Electron smoke test and do not prove real OAuth, system permissions or a signed build.

Fetching remote message text and Reply-To has a five second limit for the whole conversation. On failure it still returns the cached copy with `bodyRefresh="failed"` and leaves the account's auth state alone. An unknown Reply-To is never guessed as the reply recipient. The Node Layer uses FetchHttpClient with Node fetch, and a renderer cancel aborts the fetch. A read-only GET that fails in transport waits 500 milliseconds and retries once. Sending never retries. The implementation and regressions are in [mailbox-live.ts](../packages/core/src/mailbox/mailbox-live.ts), [provider-retry.ts](../packages/core/src/providers/provider-retry.ts) and [read-only.test.ts](../packages/core/src/mailbox/read-only.test.ts).

For a blank composer, `DraftStatus` queries only the local draft and returns `null` if the draft is unsaved or deleted. `OpenDraft` is for explicitly opening or importing an existing draft. The full flow tests check that opening and closing a blank composer causes no failed RPC and does not query messages for that draft ID. See [mailbox-handlers.ts](../apps/desktop/src/shared/mailbox-handlers.ts) and [flows.test.ts](../apps/desktop/src/renderer/src/e2e/flows.test.ts).

## Titlebar resize check

The controls beside the macOS traffic lights (the sidebar toggle, the search field, the first toolbar button) must not move while the window resizes. A DOM test cannot see this, so after building run:

```sh
pnpm build
pnpm --filter @openmail/desktop test:titlebar
```

The script seeds demo data into a temporary `OPENMAIL_HOME` with [demo-data.mjs](../scripts/demo-data.mjs), starts the preview offline, read-only and with `OPENMAIL_BACKGROUND_WINDOWS=1`, and drives the main window over a local CDP connection. It narrows the window to 600 px, resizes it in 20 px steps and back with `window.resizeTo`, and records the left edge of the toggle and the search field once per painted frame. The sampler is a `ResizeObserver` created after the app's own, so it sees each frame's layout after the app's observers have run. Then it hides and shows the sidebar in a 1320 px window (narrower when the screen is) and fails on any frame that is in neither state. Before that it checks that nothing crosses the lights' box, from the window edge to the free area and down their row: no pane divider (a border or a 1 px separator) and no control or heading. It checks the mail view and the overview at widths on both sides of each breakpoint (1320 or the screen width, 961, 960, 959, 880, 801, 800, 799 and 640 px), then sweeps from 1000 to 760 px and checks every painted frame. `--app <path to OpenMail.app>` starts that packaged app on the same demo profile instead of the preview; the Package workflow runs it this way after the unsigned build. A packaged app ignores `OPENMAIL_BACKGROUND_WINDOWS`, so its window takes focus. `--port <n>` attaches to a development build that is already running with `--remote-debugging-port=<n>` instead of starting one. `--timeout <ms>` (default 120000) bounds each attempt. If the started app exits first, the attempt fails at once, and a failed attempt includes the app's stdout and stderr under `output`. After a failed attempt the script runs the whole check once more on a fresh launch. The run fails only when both attempts fail, and `retried` in the report shows that the first one failed. The JSON report lists each attempt under `attempts`, with every check, the frames that moved, and `overlayXs`, the raw `getTitlebarAreaRect().x` values seen during the resize. `--report <path>` also writes it to a file; the Package workflow uploads that file as the `titlebar-resize` artifact, also when the step fails. Window heights are capped to `screen.availHeight` and the wide width to `screen.availWidth`, so the check fits the 1024x768 screen of a CI runner. The implementation is in [titlebar-resize.mjs](../apps/desktop/scripts/titlebar-resize.mjs).

On macOS 26 `overlayXs` holds 96 and 87: after every resize step Electron reports the titlebar area 9 px left for one frame, through `getTitlebarAreaRect()` and `env(titlebar-area-x)` alike. [titlebar-area.ts](../apps/desktop/src/renderer/src/ui/titlebar-area.ts) keeps the last settled rect until a new one holds for 200 ms, and `TrafficLightSpace` writes its width to the DOM in the same frame instead of through React state. Regressions are in [titlebar-area.test.ts](../apps/desktop/src/renderer/src/ui/titlebar-area.test.ts) and the narrow window case in [layout.test.ts](../apps/desktop/src/renderer/src/e2e/layout.test.ts).

## Light and dark appearance

The app follows the Mac's appearance, and a harness cannot switch that setting. A development build reads `OPENMAIL_APPEARANCE=light` or `OPENMAIL_APPEARANCE=dark` at startup and sets Electron's `nativeTheme.themeSource`, so every window and the reader frame use that appearance. Any other value, or no value, follows the system. Packaged builds ignore the variable. Check both appearances before you change colors, overlays or popovers, for example on the demo profile:

```sh
pnpm build
node scripts/demo-data.mjs /tmp/openmail-demo
OPENMAIL_HOME=/tmp/openmail-demo OPENMAIL_READ_ONLY=1 OPENMAIL_OFFLINE=1 OPENMAIL_APPEARANCE=light \
  apps/desktop/node_modules/.bin/electron apps/desktop --user-data-dir=/tmp/openmail-demo
```

The implementation is in [appearance.ts](../apps/desktop/src/main/windows/appearance.ts).

## Regressions by area

- [undo-journal.test.ts](../packages/core/src/mailbox/undo-journal.test.ts), [signatures.test.ts](../packages/core/src/compose/signatures.test.ts): undo across restarts, and signatures.
- [optional-services.test.ts](../packages/core/src/providers/optional-services.test.ts): consent, service switches and the message text budget.
- [graph-recurrence.test.ts](../packages/core/src/calendar/graph-recurrence.test.ts), [calendar.test.ts](../packages/core/src/calendar/calendar.test.ts): recurring events, invites and detecting events in mail.
- [search.test.ts](../packages/core/src/search/search.test.ts), [preferences.test.ts](../packages/core/src/mailbox/preferences.test.ts), [organization.test.ts](../packages/core/src/domain/organization.test.ts): search, preferences, categories and rules.
- [uid-remap.test.ts](../packages/core/src/mailbox/uid-remap.test.ts): IMAP identity mapping.
- [native-compose.test.ts](../apps/desktop/src/main/system/native-compose.test.ts): native sharing, images and writing aids.
- [sender-auth.test.ts](../packages/core/src/reader/sender-auth.test.ts), [model-view-hiding.test.ts](../packages/core/src/ai/model-view-hiding.test.ts): sender authentication and hidden model input.

`TestMailbox.withAdapter(adapter, opts)` shares a real Mailbox and Store with the in-memory platform. You can pass an adapter or derive one from the fake adapter. `incoming()`, `outgoing()` and `account(provider)` provide messages and accounts you can override. HTTP and IMAP transport use shared fakes.

The default test run collects every area regression. The 100k-conversation case in `cache.test.ts` and the 150k migration case in `performance-plans.test.ts` run only when `OPENMAIL_PERF=1` is set:

```sh
OPENMAIL_PERF=1 OPENMAIL_LOW_MEMORY_TESTS=1 pnpm --filter @openmail/core exec vitest run src/domain/cache.test.ts src/platform/node/performance-plans.test.ts
```
