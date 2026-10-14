# OpenMail

[![Check](https://github.com/Fanzzzd/openmail/actions/workflows/check.yml/badge.svg)](https://github.com/Fanzzzd/openmail/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey.svg)](#install)

English | [简体中文](README.zh-CN.md)

A local-first, keyboard-first mail client for macOS, with AI and agent access that you control.

![OpenMail inbox with a conversation open](docs/media/hero.png)

OpenMail syncs Gmail, personal Outlook and IMAP accounts into a SQLite database on your Mac. The app talks directly to your mail provider. There is no OpenMail server and no telemetry.

## Features

- **Accounts.** Gmail, personal Outlook (outlook.com, hotmail.com, live.com), iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server. Work and school Microsoft 365 accounts are not supported.
- **Local-first.** Mail lives in SQLite on your Mac. Reading, searching and organizing work offline; changes queue up and reach the server when you are back online.
- **Fast local search.** Full-text search (SQLite FTS5) with boolean, phrase, date, size and attachment operators, optionally merged with server results. Optional on-device OCR, PDF text and semantic search.
- **Keyboard-first.** Three shortcut sets (Mimestream, Gmail, Apple Mail), link hints in messages, Back and Forward, and keyboard navigation through the list, reader, composer and settings.
- **AI with approval.** Off by default, per account, with your own Anthropic API key: summaries, a mail assistant, writing help and inbox triage. The assistant proposes changes; nothing happens until you approve.
- **MCP for Claude Code and Codex.** A CLI and an MCP server read the same local database. Tools are read-only by default. Write tools only create proposals, and sending always needs your confirmation in the app. Settings can connect Claude Code, Codex, Claude and Cursor for you after showing the config diff.
- **Phone access over Tailscale.** Open your mailbox in a phone browser through your own tailnet. Off by default, never on the public internet, limited to the Tailscale logins you allow.
- **Ten languages.** English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish.
- **Safe reading.** Message HTML renders in a sandbox without scripts. Known trackers are removed under every remote-image setting.

<table>
  <tr>
    <td><img src="docs/media/search.png" alt="Search with the has:attachment operator" /></td>
    <td><img src="docs/media/settings.png" alt="Settings: connect Claude Code, Codex and Claude to your mail, read-only by default" /></td>
  </tr>
  <tr>
    <td><img src="docs/media/compose.png" alt="Composer with rich text and Write with AI" /></td>
    <td><img src="docs/media/dark.png" alt="Dark mode with an HTML newsletter" /></td>
  </tr>
</table>

The screenshots use fake mail from [`scripts/demo-data.mjs`](scripts/demo-data.mjs).

## How it compares

|                                     | OpenMail                      | Mimestream        | Spark                        | Thunderbird                    | Apple Mail          |
| ----------------------------------- | ----------------------------- | ----------------- | ---------------------------- | ------------------------------ | ------------------- |
| Source                              | Open (MIT)                    | Closed            | Closed                       | Open (MPL 2.0)                 | Closed              |
| Price                               | Free                          | Paid subscription | Free, with paid plans        | Free                           | Included with macOS |
| Platforms                           | macOS (mobile in development) | macOS             | macOS, iOS, Android, Windows | Windows, macOS, Linux, Android | macOS, iOS, iPadOS  |
| Gmail                               | Yes (Gmail API)               | Yes (Gmail API)   | Yes                          | Yes (IMAP)                     | Yes (IMAP)          |
| Personal Outlook                    | Yes (Microsoft Graph)         | No                | Yes                          | Yes                            | Yes                 |
| Other IMAP                          | Yes                           | No                | Yes                          | Yes                            | Yes                 |
| Mail path through a vendor's server | No                            | No                | Yes, for some features       | No                             | No                  |
| Maturity                            | Early testing                 | Mature            | Mature                       | Mature                         | Mature              |

OpenMail is younger than all of these and has rough edges. Mimestream is the reference for its Gmail features; the gaps are tracked in [docs/parity.md](docs/parity.md). The table reflects the products' public pages as of October 2026. If a cell is wrong, please open an issue.

## Install

There is no signed release yet. Published builds will appear on the [Releases page](https://github.com/Fanzzzd/openmail/releases). Until then, build from source:

1. Install the [prerequisites](CONTRIBUTING.md#prerequisites): macOS 13+, Node from `.nvmrc`, pnpm through `corepack enable`, and the Xcode Command Line Tools.
2. Build and package:

   ```sh
   git clone https://github.com/Fanzzzd/openmail.git
   cd openmail
   pnpm install
   pnpm build
   pnpm --filter @openmail/desktop dist   # needs Xcode 26
   ```

3. Open `apps/desktop/release/OpenMail-<version>-mac-<arch>.dmg` and drag OpenMail to Applications.

Builds that are not notarized, including your own, are blocked by Gatekeeper on first open: Control-click OpenMail in Applications, choose **Open**, and confirm.

## Quick start

1. Open OpenMail and pick **Gmail**, **Outlook** or an IMAP provider. A source build has no built-in OAuth client: register your own for [Google](docs/setup-google.md) or [Microsoft](docs/setup-microsoft.md) and paste it on the add-account screen. IMAP needs only an app password.
2. OpenMail downloads recent mail first and fills in older mail in the background.
3. Press `?` to see the keyboard shortcuts and `⌘F` to search. The [shortcut reference](https://openmail-docs.vercel.app/docs/keyboard-shortcuts) lists all three sets.
4. To use your mail from Claude Code or Codex, open **Settings > AI Access**, allow the account, then connect the app under **AI apps**. Or point any MCP client at `node packages/cli/dist/cli.js mcp`. See [CLI and MCP](https://openmail-docs.vercel.app/docs/cli-and-mcp).

## Privacy

- Mail, attachments and the search index stay in `~/Library/Application Support/openmail` (override with `OPENMAIL_HOME`).
- Refresh tokens, IMAP passwords and API keys go only to the macOS Keychain.
- The app connects to your mail provider. It connects to Anthropic only if you turn on AI, only for the accounts you allow, with your own key.
- No telemetry, no analytics, no OpenMail server.

Details: [privacy policy](https://openmail-docs.vercel.app/privacy) and [security model](https://openmail-docs.vercel.app/docs/security).

## Documentation

User docs: **[openmail-docs.vercel.app](https://openmail-docs.vercel.app)**. Developer docs are in [`docs/`](docs/) (mostly in Chinese): [architecture](docs/architecture.md), [testing](docs/testing.md), [release](docs/release.md), [security](docs/security.md).

## Contributing

Bug reports, fixes and translations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks every change must pass and the architecture rules. Ask questions in [Discussions](https://github.com/Fanzzzd/openmail/discussions). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Fanzzzd and OpenMail contributors. Third-party assets are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Provider icons by [selfh.st](https://selfh.st/icons) (CC BY 4.0).
