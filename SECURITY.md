# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/Fanzzzd/openmail/security/advisories/new)). Do not open a public issue, discussion or pull request for a security problem.

Include the OpenMail version or commit, macOS version, steps to reproduce, and what an attacker gains. A test message (`.eml`) or a minimal proof of concept helps most. Remove real mail content and tokens from anything you send.

The maintainer replies in the private advisory and agrees on a disclosure date with you once a fix is ready. OpenMail has no bug bounty.

## Supported versions

OpenMail has not had a stable release. Fixes land on `main` and go into the next release. Only the latest release gets security fixes.

| Version        | Supported |
| -------------- | --------- |
| Latest release | Yes       |
| Older releases | No        |
| `main`         | Yes       |

## In scope

- Mail content (HTML, CSS, attachments, headers, links, calendar invites) that runs script, reads local files, reaches the main process, loads remote content against the user's remote-image setting, or leaks tracking data.
- Anything that exposes OAuth tokens, IMAP passwords, AI API keys or update tokens outside the system keychain.
- IPC, deep links (`openmail:`, `mailto:`) and opened files that bypass validation.
- MCP tools that change mail without the explicit write switch, or send without confirmation in the app.
- Remote access: requests that get past the Tailscale login allowlist, the Host and Origin checks or the session cookie, or that reach an RPC outside the remote allowlist.
- Writes to another app's MCP config beyond the reviewed `openmail` entry.
- Signing, fuses or entitlements in a packaged build that weaken the protections in [docs/security.md](docs/security.md).

## Out of scope

- Other processes running as the same macOS user. They can already read the database, call `127.0.0.1` with forged Tailscale headers, and use the user's keychain access. The trust boundary is the user account, as described in [docs/security.md](docs/security.md#不在边界内).
- An attacker who controls the operating system or replaces the source or build tools.
- Decisions the project made on purpose and documents:
  - Remote images load by default. Users can change this in settings; known trackers are removed under every setting.
  - The built-in Google OAuth client secret ships inside the app. Google treats installed-app secrets as non-confidential.
  - Any device of an allowlisted Tailscale login can use remote access. Restricting devices is a tailnet ACL job.
  - Ad-hoc signed builds use `disable-library-validation`; signed builds do not.
  - Chromium's cookie-encryption keychain prompt on ad-hoc or re-signed builds.
- Company Microsoft 365 tenants, which OpenMail does not support.
- Findings that need a malicious mail provider to break TLS, or that rely only on missing headers on the docs website.
