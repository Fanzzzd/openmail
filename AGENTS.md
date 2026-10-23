# Repository Guidelines

`CLAUDE.md` is a symlink to this file. Edit only this file.

## Architecture constraints

- `packages/core` is the only place that touches the network and the database. The desktop main process, the CLI and MCP only call functions that core exports. They do not write their own SQL or call provider APIs.
- core's Node implementation lives only in `packages/core/src/platform/node/`. Other source must not import `node:`, Node built-in modules or Node-only packages. Runtime capabilities come from Effect platform services, and code must not read implicit Node globals. Only `platform/bytes.ts` may probe `globalThis.Buffer`, once, at initialization. Mobile uses `@openmail/core/portable`. The desktop compatibility entry and `@openmail/core/node` use the Node Layer. Read `docs/platform-inventory.md` when you change platform code.
- The database uses `node:sqlite`. Do not switch to better-sqlite3. `node:sqlite` ships with Node and Electron, so the app and the CLI do not need native modules rebuilt for different ABIs.
- Migrations live in the `MIGRATIONS` array in `packages/core/src/db/migrations.ts`. Only append. Do not change existing entries.
- `messages_fts` is an external-content FTS table aligned by rowid. Write messages only with `upsertMessage` (`ON CONFLICT DO UPDATE`). Do not use `INSERT OR REPLACE`: it changes the rowid and the index falls out of step.
- Refresh tokens go only into the system keychain (`packages/core/src/platform/node/secrets.ts`). They never go into the database or logs.
- Only touch accounts the user owns. Only use a client that openmail registered or that the user registered, and only get tokens through the official authorization page. Do not reuse another app's credentials or client ID, do not borrow a first-party client ID, and do not read tokens from another app's keychain items. Outlook uses only the `consumers` tenant (personal accounts). A company M365 account needs a tenant admin to authorize the app. Do not work around that.
- Mail HTML is untrusted content. The renderer's iframe must keep `sandbox` without `allow-scripts`. The CSP inside the iframe blocks remote resources. Images load only when the user's remote image setting allows them for that message. The default setting loads them. Known trackers are removed under every setting.
- MCP tools are read-only by default. A new tool that changes mail needs an explicit switch, and sending must go through human confirmation in the app.
- Change another app's MCP config (Claude Code, Codex, Claude, Cursor) only after the user clicks and has seen the diff. Prefer that app's own CLI, called through `execFile` with a fixed argv. Touch only the `openmail` entry. Reconnecting changes only `command`, `args` and `env.OPENMAIL_HOME`, and keeps the user's own keys. When you edit the file directly, first write a backup next to it, then write atomically with a temp file and rename. After the change, parse the old and new versions; apart from `openmail` they must be identical. Never put tokens in the config. Development and tests must not touch the real `~/.claude.json`, `~/.codex/config.toml` or Claude config. Use a temporary HOME and fake CLIs. See `docs/security.md#connecting-ai-apps`.
- The packaged app keeps the RunAsNode fuse off. `OpenMail --mcp` serves MCP from the main process entry. It does not rely on `ELECTRON_RUN_AS_NODE`.
- Remote access is off by default. The server binds only to 127.0.0.1, and Tailscale Serve forwards to it. Do not use Funnel. Every request must carry Tailscale-User-Login with a login on the allowlist, and the server checks Host, the WebSocket Origin and the session cookie. Remote RPCs go through the explicit table in `shared/remote-policy.ts` (`main/remote/remote-rpcs.ts` builds the RPC group from it). Any RPC not listed is rejected. A new RPC is not added to the table by default. In the web build, controls that call an RPC use `canCall(tag)` to decide whether to show. An RPC that touches local files, the system, the browser, OAuth, the keychain, MCP/AI keys, windows or the clipboard never goes into the remote table. See `docs/security.md#remote-access`.

## Electron

- The main process entry is ESM. Do not `await app.whenReady()` at the top level. Electron emits `ready` only after the entry module finishes evaluating, so it deadlocks. Use `app.once("ready", …)`.
- preload runs with sandbox on, so it must output CJS (see `electron.vite.config.ts`).
- electron-vite 5 supports only vite ≤ 7.
- Automated runs never put windows on the user's screen. A harness that only drives the renderer over CDP starts a development build with `OPENMAIL_HIDDEN_WINDOWS=1`. A harness that needs a visible window runs only on agent-screen (or another virtual display, or CI) and refuses to start without `OPENMAIL_VISIBLE_WINDOWS_OK=1`. Every show or focus call, native dialog, Quick Look, print panel, tray, notification, popup or share menu, `shell` open, macOS `open` and clipboard access in the main process goes through `apps/desktop/src/main/windows/reveal.ts`. See `docs/testing.md#windows-in-automated-runs`.

## Checks

Run before committing:

```sh
pnpm build && pnpm check-types && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .
```

Lint uses the type-aware oxlint config in `.oxlintrc.json`. `no-unsafe-type-assertion` is an error. It is allowed only at IO boundaries (SQLite rows, HTTP JSON, IPC and RPC frames), and each one needs a disable comment that states the reason.

Form controls in the renderer go through the wrappers in `apps/desktop/src/renderer/src/ui/` (Checkbox, Switch, SettingsSwitchRow, Radio, Select, NumberField, ToggleButtons, DateInput, ColorWell). The `openmail-ui/raw-controls` oxlint rule, a JS plugin in `scripts/repo-checks/oxlint/ui-controls.mjs`, fails on a native checkbox, radio, number, range, color, date or time `<input>`, a `<select>`, or a direct import of a Base UI control primitive outside `ui/`. The error names the wrapper to use. A line that must stay native carries `// ui-ok: <reason>` on the same line; an exemption without a reason fails.

UI text uses Lingui. Code holds the English source text, and translations live in `apps/desktop/src/renderer/src/locales/{locale}/messages.po`. After adding text, run `pnpm --filter @openmail/desktop i18n:extract` and fill every `msgstr` for zh-CN, cs, nl, fr, de, it, ja, ru and es. Keep ICU arguments, plurals and component tags. `pnpm --filter @openmail/desktop i18n:missing` lists missing translations per language. `pnpm test` checks catalog sync, translation completeness and arguments for every catalog. A missing translation in any language fails it.

Capitalization of UI text: always write the product name as OpenMail. Do not translate it or change its case in any language. `openmail` appears only in identifiers (setting names, file names, `svc:openmail`). Titles, buttons, menu items, labels and body text all use sentence case. Proper nouns keep their capitals: brand and product names (Gmail, Outlook, iCloud), folder names (Inbox, Trash, Spam, Focused, Other, All Mail), macOS feature names (Finder, Quick Look, Writing Tools, System Settings, Contacts), and the app's own settings page name AI Access (a glossary term). About 830 existing strings use sentence case and 60 use title case, so sentence case wins. Apple HIG asks for title case on macOS menu items and buttons. This repo deliberately does not follow it, the menu bar included, so one rule holds inside and outside the app.

When translating mail terms, read `apps/desktop/src/renderer/src/locales/glossary.json`. Refer to the message body with the "message text" wording ("消息文本" in zh-CN). When text refers to a button, insert that button's translated value and note it in the Lingui context/comment. New language strings must pass the terminology consistency test and the strict ICU parse test. Japanese plurals use only `other`. Numeric value branches may stay. <!-- cjk-ok -->

## Agent skills

### Issue tracker

Issues live in GitHub Issues of the public repo `Fanzzzd/openmail`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
