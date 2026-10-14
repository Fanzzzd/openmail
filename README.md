# OpenMail

[![Check](https://github.com/Fanzzzd/openmail/actions/workflows/check.yml/badge.svg)](https://github.com/Fanzzzd/openmail/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: macOS 13+](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey.svg)](#install)

English | [简体中文](README.zh-CN.md)

**Your mail on your Mac, readable by the agents you allow.**

![OpenMail inbox with a conversation open](docs/media/hero.png)

OpenMail keeps your mail in a SQLite database on your Mac. The app, a CLI and an MCP server all use that one database. AI agents such as Claude Code and Codex can read the accounts you allow. When an agent wants to change your mail, OpenMail turns the change into a proposal, and nothing happens until you approve it in the app.

OpenMail is a keyboard-first mail client for macOS. It syncs Gmail, personal Outlook and IMAP accounts. The app talks directly to your mail provider. There is no OpenMail server and no telemetry.

OpenMail is in early testing. Expect rough edges, and please report them in [Issues](https://github.com/Fanzzzd/openmail/issues).

## AI agents, with your approval

![An agent proposes archiving three newsletters; the user approves it in OpenMail](docs/media/approval.gif)

In this recording, Claude Code asked over MCP to archive three newsletters. OpenMail listed the request under **AI suggestions** with the agent's reason. The newsletters left the inbox only after **Approve**.

- **Per-account consent.** An agent sees an account only after you turn on **Allow AI to read this account** for it in **Settings → AI Access**. OpenMail checks this on every tool call.
- **Read-only by default.** MCP tools read and search mail. The permission to change mail starts at **Read only**, which makes every write tool refuse.
- **Proposals.** Write tools take two switches: allow proposals when you connect the app, and set the permission to **Ask me first**. Then `modify_threads`, `snooze_threads` and `draft_message` create proposals. Each one waits in **AI suggestions** until you approve or reject it.
- **No agent sends mail.** A drafted message opens in the composer, and you send it yourself.
- **Connect from Settings.** OpenMail can connect Claude Code, Codex, Claude and Cursor for you. It shows the config diff first and edits only the `openmail` entry. Any other MCP client can run `/Applications/OpenMail.app/Contents/MacOS/OpenMail --mcp`.
- **Built-in AI, off by default.** With your own Anthropic API key and only for the accounts you allow: summaries, a mail assistant, writing help and inbox triage. The assistant also proposes changes instead of making them.

See [CLI and MCP](https://openmail-docs.vercel.app/docs/cli-and-mcp) for the tool list and the approval rules.

## Features

- **Accounts.** Gmail, personal Outlook (outlook.com, hotmail.com, live.com), iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server. Work and school Microsoft 365 accounts are not supported.
- **Local-first.** Reading, searching and organizing work offline. Changes queue up and reach the server when you are back online.
- **Local search.** Full-text search (SQLite FTS5) with boolean, phrase, date, size and attachment operators, optionally merged with server results. Optional on-device OCR, PDF text and semantic search.
- **Keyboard-first.** Three shortcut sets (Mimestream, Gmail, Apple Mail), link hints in messages, Back and Forward, and keyboard navigation through the list, reader, composer and settings.
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

The screenshots and the recording use fake mail from [`scripts/demo-data.mjs`](scripts/demo-data.mjs), including the pending proposal.

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

1. Install the [prerequisites](CONTRIBUTING.md#prerequisites): macOS 13+, Node 24 (see `.nvmrc`), pnpm through `corepack enable`, and the Xcode Command Line Tools. OpenMail needs Node 24, the version in `.nvmrc`. Node 22 prints a `node:sqlite` warning on every CLI call, and Node 25 and later no longer ship corepack.
2. Build and package:

   ```sh
   git clone https://github.com/Fanzzzd/openmail.git
   cd openmail
   pnpm install
   pnpm build
   pnpm --filter @openmail/desktop dist   # needs Xcode 26
   ```

3. Open `apps/desktop/release/OpenMail-<version>-mac-<arch>.dmg` and drag OpenMail to Applications.

A build you make yourself opens normally. Gatekeeper blocks a downloaded build that is not notarized on first open. Open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.

## Quick start

1. Open OpenMail and pick **Gmail**, **Outlook** or an IMAP provider. A source build has no built-in OAuth client: register your own for Google or Microsoft as in [Using your own OAuth client](https://openmail-docs.vercel.app/docs/own-oauth-client) and paste it on the add-account screen. IMAP needs only an app password.
2. OpenMail downloads recent mail first and fills in older mail in the background.
3. Press `?` to see the keyboard shortcuts and `⌘F` to search. The [shortcut reference](https://openmail-docs.vercel.app/docs/keyboard-shortcuts) lists all three sets.
4. To use your mail from Claude Code or Codex, open **Settings → AI Access**, allow the account, then connect the app under **AI apps**. Or point any MCP client at `/Applications/OpenMail.app/Contents/MacOS/OpenMail --mcp`. [Connect by hand](https://openmail-docs.vercel.app/docs/cli-and-mcp#connect-by-hand) has the CLI command for a source checkout.

## Privacy

- Mail, attachments and the search index stay in `~/Library/Application Support/openmail` (override with `OPENMAIL_HOME`).
- Refresh tokens, IMAP passwords and API keys go only to the macOS Keychain.
- The app connects to your mail provider. It connects to Anthropic only if you turn on AI, only for the accounts you allow, with your own key.
- No telemetry, no analytics, no OpenMail server.

Details: [privacy policy](https://openmail-docs.vercel.app/privacy) and [security model](https://openmail-docs.vercel.app/docs/security).

## Documentation

User docs: **[openmail-docs.vercel.app](https://openmail-docs.vercel.app)**. Developer docs are in [`docs/`](docs/): [architecture](docs/architecture.md), [testing](docs/testing.md), [release](docs/release.md), [security](docs/security.md) and the [glossary](CONTEXT.md). Some deeper notes, such as sync correctness and performance, are still in Chinese.

## Contributing

Bug reports, fixes and translations are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks every change must pass and the architecture rules. It also shows how to [run the dev app with a separate data directory](CONTRIBUTING.md#run-the-desktop-app-without-touching-your-real-mail), so development never touches your real mail. Ask questions in [Discussions](https://github.com/Fanzzzd/openmail/discussions). Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Fanzzzd and OpenMail contributors. Third-party assets and libraries, including libvips under LGPL-3.0-or-later, are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Provider icons by [selfh.st](https://selfh.st/icons) (CC BY 4.0).
