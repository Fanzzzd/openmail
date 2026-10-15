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
- Remote images load by default; you can ask per message or load only from known senders. Known trackers are removed under every setting.
- Sender authentication badges, link confirmation for mismatched or international domains, and warnings for dangerous attachments.
- Full-text search over local mail with boolean, phrase, date, size and attachment operators, merged with server search, recent searches and match highlights.
- Optional on-device OCR (macOS Vision), PDF text and semantic search.
- Attachments you open in other apps are copied to an internal folder. Unchanged copies are deleted after 7 days, Settings → Local cache clears the rest, and Time Machine skips the folder.
- Replying to or forwarding an HTML message keeps its quote as a read-only block below an editable body. Edit quoted text joins the quote into the editor.
- A Sent copy that fails to save is tried again after 1 h, 2 h, 4 h and so on, at most a day apart, up to 10 tries in 7 days. After that OpenMail shows the notice.
- The word index is finished before CLI and MCP search and before `openmail sync`. If another process holds the write lock, `openmail search` prints a note on stderr and the MCP `search` tool returns `search_notice`: results are approximate until the index is done.
- Opening remote-session launchers, key material, certificates and the other risky attachment types needs Save first. vCard and vCalendar files open in the in-app preview.

### Writing and organizing

- Composer with rich text, plain text and Markdown, autosaved drafts synced both ways, undo send, send and archive, templates, signatures and From address choice.
- Batch actions, snooze, labels and nested folders, Gmail categories, Outlook Focused inbox, server filters and vacation replies.
- A new message in a snoozed conversation ends the snooze and returns the conversation to the Inbox.
- Replies and forwards go out when Gmail or Outlook no longer has the original message. IMAP replies stay threaded.
- IMAP setup asks for a sender name, which appears in the From line.
- Calendar invites with RSVP and recurrence, and contact suggestions from the server and, optionally, Apple Contacts.

### Desktop

- Keyboard-first: three shortcut sets, link hints, Back and Forward, command menus.
- `openmail list --space` takes a space name or id. A space name cannot repeat another space's name (any letter case), cannot be `none` and cannot be blank once control and format characters are removed.
- Spaces to group accounts, notification hours by space, menu bar and Dock integration, multiple windows, `mailto:` and `openmail:` links.
- Responsive layout from three panes down to one.
- Interface in English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish.
- Accessibility checks with axe, keyboard paths and screen reader labels.
- Close window (⌘W) closes an open Settings page, dialog or inline composer first, then the window.
- Send feedback shows a redacted diagnostics preview with accounts numbered and hashes keyed per install. Copy diagnostics pastes it into a GitHub issue.
- After three unexpected stops within five minutes, OpenMail offers to continue, reset the local mail cache and re-sync, or quit.

### AI and agents

- Optional AI per account, off by default: summaries, a mail assistant (⌘J), writing help and triage suggestions. Changes the assistant proposes wait for your approval.
- CLI (`openmail`) and an MCP server for Claude Code, Codex, Claude and Cursor. Tools are read-only by default; write tools only create AI suggestions (called proposals in `list_proposals`, `read_proposal` and `openmail proposals`), and sending always needs confirmation in the app.
- Connect AI apps from Settings, with a diff to review before any config file changes.
- Claude Sonnet 5.5, Opus 5.5 and Haiku 5.5 appear by product name with a cost note. Automatic triage stops at 100 conversations per day.

### Remote access

- Use your mailbox from a phone browser over Tailscale Serve. Off by default, bound to 127.0.0.1, limited to an allowlist of Tailscale logins and of RPCs.

### Mobile (preview)

- Expo app sharing core: Gmail, Outlook and IMAP accounts, threads, compose, search, background refresh and local notifications. Not yet tested on real devices.
