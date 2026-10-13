# Google OAuth verification

This is what OpenMail submits to Google to verify the `openmail-510100` OAuth app, and what the owner has to do that the code can't.

## Status

- Publishing status: In production, unverified. Users see the "Google hasn't verified this app" screen, and the app is capped at 100 users for its lifetime.
- Verification removes both.
- OpenMail requests restricted Gmail scopes, so verification also needs a CASA security assessment. A third-party lab authorised by Google runs it every year. Google contacts the developer about it after it reviews the scopes.

## App details for the form

| Field             | Value                                                 |
| ----------------- | ----------------------------------------------------- |
| App name          | OpenMail                                              |
| Homepage          | https://openmail-docs.vercel.app                      |
| Privacy policy    | https://openmail-docs.vercel.app/privacy              |
| Terms of service  | https://openmail-docs.vercel.app/terms                |
| Authorised domain | openmail-docs.vercel.app (verified in Search Console) |
| App type          | Desktop app (installed, loopback redirect)            |

### Short description

OpenMail is a desktop mail client for macOS. It downloads the user's mail to a database on their own Mac and shows it in a native app. The user reads, searches, labels, archives, writes and sends mail there. OpenMail has no server. Google user data goes from Google's API straight to the user's Mac and stays there.

## Scopes and why each one is needed

Every scope is requested from the user's own Mac by the desktop app. The optional scopes are requested only when the user turns on the matching feature, so a new account grants only `gmail.modify` and `gmail.send`.

### `https://www.googleapis.com/auth/gmail.modify` (restricted)

- **What it does:** the core of the app. OpenMail syncs the mailbox (messages, threads, labels, drafts) and applies the user's actions back to Gmail: mark read or unread, star, apply and remove labels, archive, move to Trash, and save drafts. It also reads send-as addresses and signatures so replies come from the right address.
- **Why a narrower scope is not enough:**
  - `gmail.readonly` can't change labels, archive or trash.
  - `gmail.labels` can't read message content.
  - `gmail.metadata` can't read bodies.
  - A mail client has to both read and change mail, and `gmail.modify` is the narrowest scope that covers both.

### `https://www.googleapis.com/auth/gmail.send` (sensitive)

- **What it does:** sends the messages the user writes. Each send is a deliberate action, and the app offers undo send.
- **Why a narrower scope is not enough:** there is no narrower scope for sending.

### `https://mail.google.com/` (restricted, on demand)

- **What it does:** permanently deletes messages and empties Trash. The app asks for this scope only the first time the user chooses "Delete permanently" or "Empty Trash", and explains why.
- **Why a narrower scope is not enough:** `gmail.modify` can't delete permanently. Google's API docs say permanent deletion needs `https://mail.google.com/`.

### `https://www.googleapis.com/auth/gmail.settings.basic` (sensitive, optional)

- **What it does:** creates, edits and deletes Gmail filters, and turns the vacation auto-reply on and off, when the user does that in OpenMail's settings.
- **When requested:** only after the user connects "Gmail settings".

### `https://www.googleapis.com/auth/contacts.readonly` and `https://www.googleapis.com/auth/contacts.other.readonly` (sensitive, optional)

- **What they do:** suggest recipients from the user's Google contacts and from Google's "Other contacts" list while they write.
- **Why read-only:** OpenMail never writes contacts.
- **When requested:** only after the user connects Contacts.

### `https://www.googleapis.com/auth/calendar.events` (sensitive, optional)

- **What it does:** for a calendar invitation the user received, finds the matching event, records the user's Accept, Maybe or Decline answer, and shows conflicting events.
- **When requested:** only after the user connects Calendar.

### `openid`, `email`, `profile`

These identify which Google account was added, so the app can show it and use the right address.

## Limited Use

The privacy policy says OpenMail follows the Google API Services User Data Policy, including Limited Use. It covers the two cases where the user can send data elsewhere:

- **AI features.** The user can send mail text to Anthropic on an account they allowed, one account at a time. This is off by default.
- **MCP clients.** The user can connect an MCP client such as Claude Code. It is read-only by default, and sending needs the user's click in the app.

OpenMail doesn't use Google user data for ads or profiling, and doesn't use it to train models. No person working on OpenMail can access user data: there is no server.

## Demo video

Google wants an unlisted YouTube video that shows the consent screen and each scope in use. Record it on the Mac in English UI, with a test Gmail account that has some mail.

Before recording:

1. Use a release build, not dev.
2. Use a fresh data folder: `OPENMAIL_HOME=$(mktemp -d)`.
3. Set the window to 1280×800 and turn off notifications.
4. Use a Gmail test account with about 20 messages, one calendar invite and a couple of labels.

Shots, about 3 minutes in total:

1. **Title card**, 5 s: "OpenMail, a desktop mail client for macOS. OAuth client: `<client ID>`."
2. **Add account**, 30 s: Add Account → Gmail. The system browser opens Google's consent screen. Zoom in on the address bar so the client ID in the URL is readable. Show the requested scopes (`gmail.modify`, `gmail.send`). Click Allow. Return to the app.
3. **gmail.modify, reading**, 30 s: the inbox syncs. Open a thread. Search for a word and open the result.
4. **gmail.modify, changing**, 30 s: mark a thread unread, star it, add a label, archive it, move another to Trash. Then open Gmail in the browser and show the same changes there.
5. **gmail.send**, 20 s: reply to a message, send, and show it in Sent in Gmail.
6. **contacts**, 20 s: Settings → Accounts → connect Contacts. The consent screen shows the contacts scopes. While writing, type a name and get a suggestion from Google Contacts.
7. **calendar.events**, 20 s: connect Calendar, open the invite, click Accept, and show the event answer in Google Calendar.
8. **gmail.settings.basic**, 20 s: connect Gmail settings, create a filter, and show it in Gmail's filter settings.
9. **mail.google.com**, 15 s: select a message in Trash and choose Delete permanently. The app explains why and asks for consent. The message disappears from Gmail.
10. **Data location**, 10 s: Settings → Local cache shows the data is on this Mac. Say "OpenMail has no server."

## What the owner does

1. Record the demo video above and upload it to YouTube as Unlisted.
2. In Google Auth Platform → Verification Center, check the form that OpenMail prepared, paste the video link, and submit.
3. Answer Google's emails. Reviews take days to weeks, and Google often asks follow-up questions about scope use.
4. Do the CASA assessment when Google asks for it. Pick an authorised lab from Google's list. Tier 2 is the usual level for an installed app. Budget for a yearly fee.
5. Each year, renew CASA and re-confirm the privacy policy.

## Ways to avoid CASA

- **Drop restricted scopes for most users.** IMAP with an app password needs no Google verification, but Gmail OAuth is a much better experience.
- **Bring your own client.** Users register their own OAuth client, as `own-oauth-client.mdx` describes. Their app stays in Testing with a 7-day token expiry, so this suits developers, not general users.

Verification plus CASA is the only path where any Gmail user can sign in without warnings.
