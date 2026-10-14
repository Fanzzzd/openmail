# Contributing to OpenMail

Thanks for helping. This file covers setup, the checks a change must pass, and the rules the code follows.

## Prerequisites

- macOS 13 or later. The desktop app, its Swift helpers and packaging target macOS only.
- OpenMail needs Node 24, the version in `.nvmrc`. Node 22 prints a `node:sqlite` warning on every CLI call, and Node 25 and later no longer ship corepack. CI tests only Node 24, and `package.json` accepts only Node 24.
- pnpm through corepack: `corepack enable`. The `packageManager` field pins the version.
- Xcode Command Line Tools (`xcode-select --install`). `pnpm build` compiles the Swift helpers.
- Xcode 26, only to build the DMG with `pnpm --filter @openmail/desktop dist`. Icon Composer needs it.

## Build and test

```sh
git clone https://github.com/Fanzzzd/openmail.git
cd openmail
pnpm install
pnpm build
OPENMAIL_LOW_MEMORY_TESTS=1 pnpm test
```

`pnpm build` builds core, the CLI, the desktop app and the docs site, and type-checks the mobile app. `OPENMAIL_LOW_MEMORY_TESTS=1` runs core tests in one worker; drop it on a machine with plenty of memory. [docs/testing.md](docs/testing.md) lists the suites and how to run one.

## Run the desktop app without touching your real mail

`pnpm dev` uses the same data directory as an installed OpenMail: `~/Library/Application Support/openmail`. Start the dev app with a separate directory instead:

```sh
pnpm build
cd apps/desktop
pnpm exec electron-vite dev -- --user-data-dir="$HOME/OpenMail-dev"
```

`--user-data-dir` moves both Electron's profile and OpenMail's database there, so it takes precedence over `OPENMAIL_HOME`. Point the CLI and MCP server at the same directory with `OPENMAIL_HOME`:

```sh
OPENMAIL_HOME="$HOME/OpenMail-dev" node packages/cli/dist/cli.js accounts list
```

Tokens and passwords still go to the macOS keychain under the service `openmail`, one item per account, named like `gmail:alex@example.com`. Signing in to the same address from a dev data directory replaces the installed app's token for it.

For a populated mailbox without a real account, seed fake mail with `node scripts/demo-data.mjs "$HOME/OpenMail-dev"` after `pnpm build`. It also sets the AI permission to **Ask me first** and adds one pending agent proposal, so **AI suggestions** has something to approve.

Set `OPENMAIL_READ_ONLY=1` to block every remote write (sending, moves, flags) while you try things.

## OAuth clients for development

OpenMail signs in to Gmail and personal Outlook with an OAuth client. A source checkout has none built in. Either:

- register your own client as in [docs/setup-google.md](docs/setup-google.md) and [docs/setup-microsoft.md](docs/setup-microsoft.md), then paste it on the add-account screen, or
- put it in `apps/desktop/oauth-clients.local.json` (gitignored) and rebuild. The desktop build and the CLI both read it:

  ```json
  {
    "google": { "clientId": "…", "clientSecret": "…" },
    "microsoft": { "clientId": "…" }
  }
  ```

Use a client you registered yourself. Do not reuse another app's client ID or credentials. IMAP accounts need no client.

[`scripts/setup-oauth.sh`](scripts/setup-oauth.sh) walks you through the same console steps in the terminal. Run it after `pnpm build`. It opens each console page, asks for the client ID and secret, and saves them with `openmail config`. It writes only OpenMail's `config.json`.

## Where things live

| Path                                                                         | What it holds                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/`                                                         | Everything that touches mail, the network or the database. The top level holds only the package entries: `index.ts` (Node), `portable.ts` (mobile), `schema.ts` (renderer) and `common.ts`. |
| `packages/core/src/domain/`                                                  | Schemas for accounts, messages, changes, settings and commands. Start here to learn the data model.                                                                                         |
| `packages/core/src/mailbox/`                                                 | The `Mailbox` service every app calls, its `mailbox-*.ts` parts, policy, the read-only session and undo.                                                                                    |
| `packages/core/src/store/`, `db/`                                            | SQLite queries, and the append-only migrations in `db/migrations.ts`.                                                                                                                       |
| `packages/core/src/sync/`                                                    | Sync health, sync reset and backfill.                                                                                                                                                       |
| `packages/core/src/providers/`                                               | The `ProviderAdapter` port and its `gmail/`, `outlook/` and `imap/` implementations.                                                                                                        |
| `packages/core/src/compose/`, `mime/`, `reader/`, `visible-text/`, `search/` | Writing mail, parsing MIME, cleaning HTML for the reader, the text models see, and search.                                                                                                  |
| `packages/core/src/calendar/`, `contacts/`                                   | Calendar events and invites; contacts.                                                                                                                                                      |
| `packages/core/src/ai/`, `tools/`                                            | Models and local indexing; the MailToolkit, one `*-tools.ts` module per group of tools.                                                                                                     |
| `packages/core/src/app/`                                                     | Desktop helpers: links, notifications, updates, remote access.                                                                                                                              |
| `packages/core/src/platform/`                                                | Platform ports. `platform/node/` is the Node implementation and the only place Node APIs are allowed; `platform/react-native/` holds the mobile adapters.                                   |
| `apps/desktop/src/main/`                                                     | The Electron main process, by area: `app/`, `windows/`, `rpc/`, `security/`, `files/`, `updates/`, `system/`, `remote/`, `agents/`.                                                         |
| `apps/desktop/src/shared/`                                                   | Code shared by main and renderer: the RPC protocol, Mailbox handlers, routes and the remote policy.                                                                                         |
| `apps/desktop/src/renderer/src/`                                             | The UI: `app/` assembles the window, `features/<name>/` holds one feature each, `state/` holds RPC and atoms, `ui/` and `lib/` hold shared pieces.                                          |
| `packages/cli/src/`                                                          | The CLI: `cli.ts` runs it, `commands/` holds the commands by group, `mcp-server.ts` is the MCP server.                                                                                      |
| `apps/mobile/`                                                               | The Expo app.                                                                                                                                                                               |
| `apps/docs/`                                                                 | The documentation site.                                                                                                                                                                     |

Tests sit next to the file they test. [docs/architecture.md](docs/architecture.md) has the full map, and [docs/adr/0001-core-layout.md](docs/adr/0001-core-layout.md) explains the core layout. Two checks keep it in shape:

- `pnpm exec oxlint` fails on any import cycle, type-only imports included.
- `scripts/repo-checks/src/platform-imports.test.ts` fails if a new module lands at the top of `packages/core/src` or a non-Node folder imports a Node API.

Keep source files under about 800 lines. When one grows past that, split it along a real boundary, such as a sub-component, a hook or one group of handlers.

## Before you open a pull request

Run the same gate as CI:

```sh
pnpm build && pnpm check-types && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .
```

`pnpm exec oxfmt .` fixes formatting. Lint is type-aware. Keep each pull request to one change, and say in the description how you tested it.

## Architecture rules

[AGENTS.md](AGENTS.md) is the full list, in Chinese. In short:

- `packages/core` is the only code that touches the network or the database. The desktop main process, the CLI and the MCP server call functions core exports. They write no SQL and call no provider API.
- Node-specific core code lives only in `packages/core/src/platform/node/`. Other core sources import no `node:` modules, Node built-ins or Node-only packages, and read no Node globals; runtime capabilities come from Effect platform services. Only `platform/bytes.ts` may probe `globalThis.Buffer`, once at startup. Read [docs/platform-inventory.md](docs/platform-inventory.md) before changing platform code.
- The database is `node:sqlite`. Do not switch to better-sqlite3.
- Migrations live in the `MIGRATIONS` array in `packages/core/src/db/migrations.ts`. Append only; never edit an existing entry.
- `messages_fts` is an external-content FTS table keyed by rowid. Write messages only through `upsertMessage`, never `INSERT OR REPLACE`.
- Refresh tokens, IMAP passwords and AI keys go only to the system keychain (`packages/core/src/platform/node/secrets.ts`), never to the database or logs.
- Only the user's own accounts, through the official consent page, with OpenMail's or the user's own OAuth client. Never reuse another app's client ID or credentials, and never read tokens from another app's keychain items. Outlook uses the `consumers` tenant only; work Microsoft 365 needs the tenant admin's consent, which OpenMail does not work around.
- Mail HTML is untrusted. The reader iframe's `sandbox` never includes `allow-scripts`, and its CSP blocks remote content unless the remote-image setting allows it. Known trackers are always removed.
- MCP tools are read-only by default. A tool that changes mail needs an explicit switch, and sending always needs confirmation in the app.
- Changes to another app's MCP config happen only after the user clicks and reviews the diff, and touch only the `openmail` entry. Prefer that app's own CLI through `execFile` with a fixed argv. When editing a file directly, back it up, write atomically, and check that everything outside `openmail` is unchanged. Config never holds tokens. Tests use a temporary HOME and fake CLIs, never the real `~/.claude.json` or `~/.codex/config.toml`. See [docs/security.md](docs/security.md#connecting-ai-apps).
- Remote access is off by default, binds to 127.0.0.1 behind Tailscale Serve (never Funnel), and allows only the RPCs listed in `shared/remote-policy.ts`. New RPCs stay off that list unless there is a reason. RPCs that touch local files, the system, the browser, OAuth, the keychain, AI keys, windows or the clipboard never go on it. See [docs/security.md](docs/security.md#remote-access).
- The packaged app keeps the RunAsNode fuse off. `OpenMail --mcp` serves MCP from the main entry, not through `ELECTRON_RUN_AS_NODE`.
- Electron: the main entry is ESM and must not `await app.whenReady()` at top level; the sandboxed preload builds as CJS; electron-vite 5 needs vite 7 or earlier.

## Translations

The UI uses [Lingui](https://lingui.dev). Write English source strings in code. After adding or changing strings:

```sh
pnpm --filter @openmail/desktop i18n:extract
pnpm --filter @openmail/desktop i18n:missing
```

Fill every `msgstr` in `apps/desktop/src/renderer/src/locales/{locale}/messages.po` for zh-CN, cs, nl, fr, de, it, ja, ru and es. Keep ICU arguments, plurals and component tags as they are. Japanese plurals use only `other`. Follow the mail terms in `apps/desktop/src/renderer/src/locales/glossary.json`. `pnpm test` fails on any missing or out-of-sync translation. The mobile app has the same commands under `@openmail/mobile` (`i18n:extract`, `i18n:missing`), with its catalogs in `apps/mobile/src/locales/`.

If you can't translate a language, say so in the pull request and a maintainer will fill it in.

## Questions and bugs

- Questions and ideas: [GitHub Discussions](https://github.com/Fanzzzd/openmail/discussions).
- Bugs and feature requests: [GitHub Issues](https://github.com/Fanzzzd/openmail/issues), using the templates.
- Security problems: see [SECURITY.md](SECURITY.md). Do not open a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
