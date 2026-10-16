# Changelog

All notable changes to OpenMail are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

The first public version. Everything below is new.

### Accounts and sync

- Gmail and personal Outlook through OAuth, with OpenMail's built-in clients or your own. The browser page after sign-in is a centered card with a status icon and follows light or dark mode. iCloud, Yahoo, QQ, 163, Fastmail and any IMAP/SMTP server with an app password.
- Local-first storage in SQLite (`node:sqlite`), shared by the desktop app, the CLI and the MCP server.
- Incremental sync, an offline change queue with retries, resumable backfill of older mail, and IMAP IDLE for new-mail signals.
- Sync health check that compares server and local counts per folder. Sync resets delete only inside the listed window and confirm mass deletions with the server.
- Local cache rules per folder and label, with an attachment cache and a cache settings page.
- A dropped IMAP connection, such as Wi-Fi turning off mid-sync, counts as a network failure and shows "Can't reach the mail server right now."
- Provider error messages keep at most 2,000 characters of a response body.
- Adding an IMAP address again replaces its password and keeps its sender name and, on the same server, its authentication service trust.

### Reading and search

- Conversation and single-message views, find in message, quoted text folding, raw source and EML export, print and PDF.
- Remote images load by default; you can ask per message or load only from known senders. Known trackers are removed under every setting.
- Sender authentication badges, link confirmation for mismatched or international domains, and warnings for dangerous attachments.
- Full-text search over local mail with boolean, phrase, date, size and attachment operators, merged with server search, recent searches and match highlights.
- Optional on-device OCR (macOS Vision), PDF text and semantic search.
- Attachments you open in other apps are copied to an internal folder. Unchanged copies are deleted after 7 days, Settings → Local cache clears the rest, and Time Machine skips the folder.
- Replying to or forwarding an HTML message keeps its quote as a read-only block below an editable body. Edit quoted text joins the quote into the editor.
- A Sent copy that fails to save is tried again after 1 h, 2 h, 4 h and so on, at most a day apart, up to 10 tries in 7 days. After that OpenMail shows a notice.
- OpenMail finishes the word index before CLI and MCP search and before `openmail sync`. If another process holds the write lock, `openmail search` prints a note on stderr and the MCP `search` tool returns `search_notice`: results are approximate until the index is done.
- Date and size operators without a valid value, such as `newer:foo` or `larger:xyz`, are searched as plain text. MCP `search` and `openmail search --json` list them under `ignored`, and `openmail search` prints a note on stderr with the accepted forms.
- Opening remote-session launchers, key material, certificates and the other risky attachment types needs Save first. vCard and vCalendar files open in the in-app preview.
- Inline images show when the message's raw source is 8 MB or less. Above that they show as broken, and OpenMail does not download the whole message to find them. Attachments download normally. An Outlook message with a 4 MB PDF next to a logo shows its images.
- A space typed after plain words stays in the search field, and the field keeps focus when results replace the list, as in the narrow layout or with the reading pane hidden. A word typed after an operator chip starts a new word, so `board notes is:unread next` searches for `board notes` and `next`.
- A search keeps the open conversation when it is among the results. Clearing the search reopens the conversation that was open before it, scrolls the list back to where it was and puts focus on that row.
- The open conversation stays open while a search is being typed, and stays selected when the results the search settles on include it.
- While a search is typed, its last word matches as a prefix, so `asy` finds "async". A space or Enter ends the word. Server search, saved searches, the CLI and MCP run the words as typed.
- Only known operators become chips or reach the note about operators a server can't search. `design 10:00 review`, `re:` and URLs search as text.
- After a failed server search, the end of the list says "No more messages on this Mac".

### Writing and organizing

- Composer with rich text, plain text and Markdown, autosaved drafts synced both ways, undo send, send and archive, templates, signatures and From address choice.
- Batch actions, snooze, labels and nested folders, Gmail categories, Outlook Focused inbox, server filters and vacation replies.
- A new message in a snoozed conversation ends the snooze and returns the conversation to the Inbox.
- Replies and forwards go out when Gmail or Outlook no longer has the original message. IMAP replies stay threaded.
- IMAP setup asks for a sender name, which appears in the From line.
- Calendar invites with RSVP and recurrence, and contact suggestions from the server and, optionally, Apple Contacts.
- Copy to folders is a menu item in the conversation and batch menus, so the arrow keys reach it. Enter opens its form after the menu closes, at the row or the Batch actions button whose menu opened it. The item is hidden when the account has no folders to copy to.
- The delete confirmation for a label or folder names it, for example: Delete the folder “Projects”?
- After Select all, the batch bar says "More messages not loaded" while the server still has older mail.
- Copy to folders and Categories are icon buttons in the conversation toolbar, named in their tooltip.
- A draft saved on this Mac that is only waiting to sync closes without a prompt. The prompt reads "This draft has unsaved changes or couldn't sync." and appears for unsaved changes or a sync that stopped.

### Desktop

- Keyboard-first: three shortcut sets, link hints, Back and Forward, command menus.
- `openmail list --space` takes a space name or id. A space name cannot repeat another space's name (any letter case), cannot be `none`, cannot equal another space's id and cannot be blank once control and format characters are removed. Names are compared after NFKC normalization. A name with a line break or tab says "A space name can't contain line breaks or tabs." A name that equals another space's id says "That is another space's id. Choose another name."
- The space editor rings the selected icon in dark mode, clears a save error once you edit the name, and names each color in words for screen readers.
- Switch spaces from the sidebar, the icon rail or the space shortcuts.
- The Go menu lists Overview (⌃1), All accounts (⌃2) and each space (⌃⌘1 to ⌃⌘9, or ⌘1 to ⌘9 with Gmail keys), and follows changes to the spaces.
- Beside the overview, the docked sidebar is labelled Sidebar and its resize handle sits inside the main landmark.
- The sidebar titles an Outlook or IMAP account's own mailboxes Folders. Gmail keeps Labels.
- Spaces to group accounts, notification hours by space, menu bar and Dock integration, multiple windows, `mailto:` and `openmail:` links.
- Responsive layout from three panes down to one.
- Interface in English, Simplified Chinese, Czech, Dutch, French, German, Italian, Japanese, Russian and Spanish.
- Accessibility checks with axe, keyboard paths and screen reader labels.
- Close window (⌘W) closes an open menu, Select list or suggestion list, Settings page, dialog or inline composer first, then the window.
- Closing a dialog returns focus to the control that opened it, including a dialog opened from Settings.
- Czech, French, Italian, Russian and Spanish labels start with a capital where the English text does.
- Send feedback shows a redacted diagnostics preview with accounts numbered and hashes keyed per install. Copy diagnostics pastes it into a GitHub issue.
- After three unexpected stops within five minutes, OpenMail offers to continue, reset the local mail cache and re-sync, or quit.
- Selection, unread, not-loaded and filter preview counts use plural forms in every language. The notice for older messages on the server reads as such in French, Russian, Japanese, Spanish, Italian and Dutch.
- The batch bar says "(loaded)" and counts the messages not loaded only when every loaded conversation is selected.

### AI and agents

- Optional AI per account, off by default: summaries, a mail assistant (⌘J), writing help and triage suggestions. Changes the assistant proposes wait for your approval.
- CLI (`openmail`) and an MCP server for Claude Code, Codex, Claude and Cursor. Tools are read-only by default; write tools only create AI suggestions (called proposals in `list_proposals`, `read_proposal` and `openmail proposals`), and sending always needs confirmation in the app.
- MCP tools return the `busy` error when another OpenMail process holds the write lock past the timeout. During the search backfill, each backfill step waits at most 200 ms for the lock and tries again later, so MCP stays responsive. Each call's activity row is written in the background, in call order, and is saved or logged when the server closes. A held lock does not fail the call.
- `openmail accounts add` and `openmail accounts reauth` print the sign-in URL after "If nothing opens, visit:", so you can open it by hand over SSH or on a Mac with no browser.
- A failed `openmail sync` says "Sync could not finish. Run it again, or add --log-level warn to see why."
- The CLI logs only errors by default. `--log-level warn` shows diagnostics.
- `openmail search -newsletter` reads words that start with `-` as query text. `--` before the query also works.
- CLI commands fail with code `busy` and a retry hint when another OpenMail process keeps the write lock. `openmail-mcp` prints the same two lines on stderr when the lock keeps it from opening the database.
- The CLI and MCP server start without the write lock when an account from an older version has no stored OAuth scopes, so `openmail mcp` opens while the app is writing.
- `openmail sync --json` prints one JSON document. When an account fails, `{"results": [...]}` also gets an `error` object.
- When every failed account needs a new sign-in, `openmail sync` tells you to sign in again, not to rerun it.
- `openmail sync --log-level warn` prints each unknown failure's error type, status and message, without addresses or tokens. `--log-level debug` adds the other failures. The hint leaves out a flag you already passed.
- `openmail mcp`, `openmail-mcp` and `OpenMail --mcp` all log warnings and errors by default and take `--log-level`.
- `openmail spaces add --color` takes the color names the app shows: purple, red, brown, green and gray. The old keys still work.
- The CLI and MCP page lists every `code` the CLI prints with `--json`.
- Connect AI apps from Settings, with a diff to review before any config file changes.
- AI Access activity shows the account for a suggested or refused change when all its conversations are in one account.
- `openmail sync` and the MCP `sync` tool report `busy` once when another OpenMail process keeps the write lock. `openmail sync` stops at the first busy account.
- `OpenMail --mcp` prints an error line and a hint on stderr when it cannot start, like `openmail mcp`.
- MCP read calls answer without waiting for a write lock another process holds. The activity row waits in the background.
- Sign-in lines for an IMAP account name `openmail accounts add imap` with the account's server settings. `openmail accounts reauth` on an IMAP account prints that command as its hint.
- `--log-level` takes any letter case. A value that is no level is a usage error with exit code 2.
- AI Access counts an entry with `--log-level` as connected, and Reconnect keeps the flag.
- `openmail sync --log-level warn` prints each failure on one line of at most 300 characters, without control characters, encoded addresses, display names or URL fragments.
- `openmail search --server` exits 1 with code `provider_unavailable` when the server search failed for every account.
- `openmail accounts list` names `openmail sync` as the next step for a stored sync error.
- Claude Sonnet 5.5, Opus 5.5 and Haiku 5.5 appear by product name with a cost note. Automatic triage stops at 100 conversations per day.

### Remote access

- Use your mailbox from a phone browser over Tailscale Serve. Off by default, bound to 127.0.0.1, limited to an allowlist of Tailscale logins and of RPCs.
- On a phone, Cc/Bcc sits on its own line under To, so the To chip keeps a recipient's name.

### Mobile (preview)

- Expo app sharing core: Gmail, Outlook and IMAP accounts, threads, compose, search, background refresh and local notifications. Not yet tested on real devices.
