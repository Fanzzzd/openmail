# Changelog

All notable changes to OpenMail are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

The first public version.

### Accounts and sync

- Gmail and personal Outlook through OAuth, with the built-in clients in release builds. A source build uses your own client. iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server with an app password. IMAP and SMTP connect only over TLS.
- Local-first storage in SQLite (`node:sqlite`), shared by the desktop app, the CLI and the MCP server. Refresh tokens and IMAP passwords stay in the macOS keychain, never in the database or logs. While another process holds the write lock, the app waits briefly, backs off and polls again later, and still records a sign-in that stopped working.
- Incremental sync, an offline change queue with retries, resumable backfill of older mail, and IMAP IDLE for new-mail signals.
- A sync health check compares server and local counts per folder. A sync reset deletes only inside the listed window and confirms mass deletions with the server.
- Local cache rules per folder and label, with an attachment cache and a cache settings page.
- Sign in again for an IMAP account opens with its address, username and servers filled in, so only the password is typed again.

### Reading and search

- Conversation and single-message views, find in message, quoted text folding, raw source and EML export, print and PDF.
- Message HTML renders in a sandbox without scripts. Remote images load by default; you can ask per message or load only from known senders. Known trackers are removed under every setting.
- Sender authentication badges, link confirmation for mismatched or international domains, and warnings for dangerous attachments. Remote-session launchers, key material, certificates and other risky types need Save before they open. vCard and vCalendar files open in the in-app preview.
- Inline images show when the message's raw source is 8 MB or less. OpenMail does not download a larger message to find them. Attachments download normally.
- Attachments you open in other apps are copied to an internal folder. Unchanged copies are deleted after 7 days, Settings → Local cache clears the rest, and Time Machine skips the folder.
- Full-text search over local mail with boolean, phrase, date, size and attachment operators, merged with server search, recent searches and match highlights. Size operators work on Outlook too, from an estimate of body and attachment sizes. A trailing `*` is accepted on `from:`, `to:`, `cc:`, `bcc:`, `filename:`, `list:` and `deliveredto:`, which already match any part of the value. `label:` matches label names in any case. A search keeps the open conversation when it is among the results. Clearing the search reopens the conversation from before and scrolls the list back to it.
- While you type a search, its last word matches as a prefix, so `asy` finds "async" and `10:0` finds 10:00. A typed space ends the word; Enter keeps it a prefix, and so does a recent search picked from the list. Saved searches, server search, the CLI and MCP run the words as typed.
- Optional on-device OCR (macOS Vision), PDF text and semantic search.

### Writing and organizing

- Composer with rich text, plain text and Markdown, autosaved drafts synced both ways, undo send that still delivers when the Mac sleeps during the undo window, send and archive, templates, signatures and From address choice.
- Replying to or forwarding an HTML message keeps its quote as a read-only block below an editable body. Edit quoted text joins the quote into the editor.
- Replies and forwards go out when Gmail or Outlook no longer has the original message. IMAP replies stay threaded.
- A Sent copy that fails to save is tried again with growing gaps, up to 10 tries in 7 days. After that OpenMail shows a notice.
- Batch actions, snooze, copy to folders, labels and nested folders, Gmail categories, Outlook Focused inbox, server filters and vacation replies. A new message in a snoozed conversation returns it to the Inbox.
- Calendar invites with RSVP and recurrence, and contact suggestions from the server and, optionally, Apple Contacts.

### Desktop

- Keyboard-first: three shortcut sets, link hints, Back and Forward, command menus.
- Spaces group accounts, such as Work and Personal, each with its own notification hours. Switch from the sidebar, the icon rail, the Go menu or the space shortcuts; the Go menu works with no window open. Overview shows every space with unread counts and sync status.
- Menu bar and Dock integration, multiple windows, `mailto:` and `openmail:` links, and a layout that goes from three panes down to one.
- Interface in English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish, with plural forms in every language.
- Accessibility checks with axe, keyboard paths and screen reader labels. Closing a dialog returns focus to the control that opened it.
- Send feedback shows a redacted diagnostics preview with accounts numbered and hashes keyed per install. Copy diagnostics pastes it into a GitHub issue.
- After three unexpected stops within five minutes, OpenMail offers to continue, reset the local mail cache and re-sync, or quit.

### AI and agents

- Optional AI per account, off by default: summaries, a mail assistant (⌘J), writing help and triage suggestions. Changes the assistant proposes wait for your approval. Automatic triage stops at 100 conversations per day. Claude Sonnet 5.5, Opus 5.5 and Haiku 5.5 appear by product name with a cost note.
- An MCP server for Claude Code, Codex, Claude and Cursor, started by `OpenMail --mcp`, `openmail mcp` or `openmail-mcp`. Tools are read-only by default. Write tools only create AI suggestions (proposals in `list_proposals` and `openmail proposals`), and sending always needs confirmation in the app. A display name with an address in it is dropped from agent draft recipients, so a chip always shows the address it sends to.
- An MCP client reads only the accounts where you turned on Allow AI to read this account. Tool results mark mail content as untrusted. `OPENMAIL_READ_ONLY=1` blocks every write to the mail server from the CLI or the MCP server.
- The Anthropic API key lives in the keychain. Only Remove key deletes it; saving a blank key fails.
- Connect AI apps from Settings → AI Access, with a diff to review before any config file changes. AI Access activity shows the tools each app called.

### Command line

- The `openmail` CLI reads the same local database as the app: accounts, spaces, sync, list, search, show, health, audit and proposals. `openmail tool` runs any agent tool exactly as an MCP client would. The CLI has no send command.
- `openmail accounts add gmail` and `outlook` sign in through the browser and print the sign-in URL for use over SSH. `openmail accounts add imap` takes a preset and reads the app password from `OPENMAIL_IMAP_PASSWORD` or a prompt.
- `openmail list --space` takes a space name or id. `openmail spaces add --color` takes blue, purple, red, orange, brown, green, teal or gray.
- Every `--json` output is one JSON document with snake_case keys. A failure adds a `message`, a `code` and a `hint`, and the CLI and MCP page lists every code.
- When another OpenMail process keeps the database write lock, CLI commands and MCP tools fail with code `busy` and a hint to retry, and `openmail sync` stops at the first busy account. MCP read calls answer without waiting for the lock.
- The CLI logs only errors by default. `--log-level warn` shows diagnostics, without addresses or tokens.

### Remote access

- Use your mailbox from a phone browser over Tailscale Serve. Off by default, bound to 127.0.0.1, limited to an allowlist of Tailscale logins and of RPCs.

### Mobile (preview)

- Expo app sharing core: Gmail, Outlook and IMAP accounts, threads, compose, search, background refresh and local notifications. Not yet tested on real devices.
