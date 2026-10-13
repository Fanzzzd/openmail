# Contributing to OpenMail

Thanks for helping. This file covers setup, the checks a change must pass, and the rules the code follows.

## Prerequisites

- macOS 13 or later. The desktop app, its Swift helpers and packaging target macOS only.
- Node from [`.nvmrc`](.nvmrc) (24.x). `package.json` requires at least 22.13 for `node:sqlite`.
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

For a populated mailbox without a real account, seed fake mail with `node scripts/demo-data.mjs "$HOME/OpenMail-dev"` after `pnpm build`.

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

## Before you open a pull request

Run the same gate as CI:

```sh
pnpm build && pnpm check-types && pnpm test && pnpm exec oxlint && pnpm exec oxfmt --check .
```

`pnpm exec oxfmt .` fixes formatting. Lint is type-aware. Keep each pull request to one change, and say in the description how you tested it.

## Architecture rules

[AGENTS.md](AGENTS.md) is the full list, in Chinese. In short:

- `packages/core` is the only code that touches the network or the database. The desktop main process, the CLI and the MCP server call functions core exports. They write no SQL and call no provider API.
- Node-specific core code lives only in `packages/core/src/platform/node/`. Other core sources import no `node:` modules and read no Node globals; runtime capabilities come from Effect platform services. Read [docs/platform-inventory.md](docs/platform-inventory.md) before changing platform code.
- The database is `node:sqlite`. Do not switch to better-sqlite3.
- Migrations live in the `MIGRATIONS` array in `packages/core/src/db.ts`. Append only; never edit an existing entry.
- `messages_fts` is an external-content FTS table keyed by rowid. Write messages only through `upsertMessage`, never `INSERT OR REPLACE`.
- Refresh tokens, IMAP passwords and AI keys go only to the system keychain (`secrets.ts`), never to the database or logs.
- Only the user's own accounts, through the official consent page, with OpenMail's or the user's own OAuth client. Outlook uses the `consumers` tenant only.
- Mail HTML is untrusted. The reader iframe's `sandbox` never includes `allow-scripts`, and its CSP blocks remote content unless the remote-image setting allows it. Known trackers are always removed.
- MCP tools are read-only by default. A tool that changes mail needs an explicit switch, and sending always needs confirmation in the app.
- Changes to another app's MCP config happen only after the user clicks and reviews the diff, and touch only the `openmail` entry.
- Remote access is off by default, binds to 127.0.0.1 behind Tailscale Serve, and allows only the RPCs listed in `shared/remote-policy.ts`. New RPCs stay off that list unless there is a reason.
- Electron: the main entry is ESM and must not `await app.whenReady()` at top level; the sandboxed preload builds as CJS; electron-vite 5 needs vite 7 or earlier.

## Translations

The UI uses [Lingui](https://lingui.dev). Write English source strings in code. After adding or changing strings:

```sh
pnpm --filter @openmail/desktop i18n:extract
pnpm --filter @openmail/desktop i18n:missing
```

Fill every `msgstr` in `apps/desktop/src/renderer/src/locales/{locale}/messages.po` for zh-CN, cs, nl, fr, de, it, ja, ru and es. Keep ICU arguments, plurals and component tags as they are. Japanese plurals use only `other`. Follow the mail terms in `apps/desktop/src/renderer/src/locales/glossary.json`. `pnpm test` fails on any missing or out-of-sync translation. The mobile app has the same commands under `@openmail/mobile`.

If you can't translate a language, say so in the pull request and a maintainer will fill it in.

## Questions and bugs

- Questions and ideas: [GitHub Discussions](https://github.com/Fanzzzd/openmail/discussions).
- Bugs and feature requests: [GitHub Issues](https://github.com/Fanzzzd/openmail/issues), using the templates.
- Security problems: see [SECURITY.md](SECURITY.md). Do not open a public issue.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
