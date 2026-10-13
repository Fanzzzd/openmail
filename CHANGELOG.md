# Changelog

All notable changes to OpenMail are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

The first public version. Everything below is new.

### Accounts and sync

- Gmail and personal Outlook through OAuth, with OpenMail's built-in clients or your own. iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server with an app password.
- Local-first storage in SQLite (`node:sqlite`), shared by the desktop app, the CLI and the MCP server.
- Incremental sync, an offline change queue with retries, resumable backfill of older mail, and IMAP IDLE for new-mail signals.
- Sync health check that compares server and local counts per folder. Sync resets delete only inside the listed window and confirm mass deletions with the server.
- Local cache rules per folder and label, with an attachment cache and a cache settings page.

### Reading and search

- Conversation and single-message views, find in message, quoted text folding, raw source and EML export, print and PDF.
- Remote images load by default with a per-message prompt; known trackers are removed under every setting.
- Sender authentication badges, link confirmation for mismatched or international domains, and warnings for dangerous attachments.
- Full-text search over local mail with boolean, phrase, date, size and attachment operators, merged with server search, recent searches and match highlights.
- Optional on-device OCR (macOS Vision), PDF text and semantic search.

### Writing and organizing

- Composer with rich text, plain text and Markdown, autosaved drafts synced both ways, undo send, send and archive, templates, signatures and From address choice.
- Batch actions, snooze, labels and nested folders, Gmail categories, Outlook Focused inbox, server filters and vacation replies.
- Calendar invites with RSVP and recurrence, and contact suggestions from the server and, optionally, Apple Contacts.

### Desktop

- Keyboard-first: three shortcut sets, link hints, Back and Forward, command menus.
- Profiles to group accounts, notification hours, menu bar and Dock integration, multiple windows, `mailto:` and `openmail:` links.
- Responsive layout from three panes down to one.
- Interface in English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish.
- Accessibility checks with axe, keyboard paths and screen reader labels.

### AI and agents

- Optional AI per account, off by default: summaries, a mail assistant (Cmd-J), writing help and triage suggestions. Changes the assistant proposes wait for your approval.
- CLI (`openmail`) and an MCP server for Claude Code, Codex, Claude and Cursor. Tools are read-only by default; write tools only create proposals, and sending always needs confirmation in the app.
- Connect AI apps from Settings, with a diff to review before any config file changes.

### Remote access

- Use your mailbox from a phone browser over Tailscale Serve. Off by default, bound to 127.0.0.1, limited to an allowlist of Tailscale logins and of RPCs.

### Mobile (preview)

- Expo app sharing core: Gmail, Outlook and IMAP accounts, threads, compose, search, background refresh and local notifications. Not yet tested on real devices.
