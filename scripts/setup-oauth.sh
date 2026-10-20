#!/usr/bin/env bash
#
# Walks you through registering your own Google and Microsoft OAuth clients for
# development, then saves them with the CLI (`openmail config google|microsoft`).
# It writes only OpenMail's config.json and never sets GitHub secrets.
# The steps follow docs/setup-google.md and docs/setup-microsoft.md. Keep them in sync.
#
# Run after `pnpm build`: scripts/setup-oauth.sh [data-folder]

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard helpers: output, prompts and progress.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# The stages section sets this once it knows which providers you chose.
TOTAL_STAGES=0

_STAGE_INDEX=0
SKIPPED=() # steps left for the user to do by hand

# _clear wipes the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" shows the opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later. Clients you already saved stay in config.json.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" clears the screen, then announces a stage and shows progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." prints a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." is a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL opens it in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser; visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser, so visit it manually: $url"
}

# pause "msg" waits for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" is a y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# ask KEY "Prompt" reads a visible value into $KEY.
ask() {
  local input=""
  printf '  %s%s%s ' "$BOLD" "$2" "$RESET"
  read -r input || true
  printf -v "$1" '%s' "$input"
}

# ask_secret KEY "Prompt" is like ask, but input is hidden.
ask_secret() {
  local input=""
  printf '  %s%s%s ' "$BOLD" "$2" "$RESET"
  read -rs input || true
  printf '\n'
  printf -v "$1" '%s' "$input"
}

# finish clears, then shows a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}


# ──────────────────────────────────────────────────────────────────────────
# Stages
# ──────────────────────────────────────────────────────────────────────────

usage() {
  cat <<'USAGE'
Usage: scripts/setup-oauth.sh [data-folder]

Saves the OAuth clients in <data-folder>/config.json. Without the argument it uses
OPENMAIL_HOME, or the installed OpenMail's data folder when OPENMAIL_HOME is unset.
For a dev app started with --user-data-dir, pass that same folder.
USAGE
}
case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  -*) usage >&2; exit 2 ;;
esac
if (( $# > 1 )); then usage >&2; exit 2; fi

# The data folder: the argument, else OPENMAIL_HOME, else the folder the installed app and the
# CLI use by default (dataDirFor in packages/core/src/platform/node/paths.ts).
INSTALLED_APP_FOLDER=0
if [[ -n "${1:-}" ]]; then
  DATA_DIR="$1"
elif [[ -n "${OPENMAIL_HOME:-}" ]]; then
  DATA_DIR="$OPENMAIL_HOME"
else
  INSTALLED_APP_FOLDER=1
  if [[ "$(uname -s)" == Darwin ]]; then
    DATA_DIR="$HOME/Library/Application Support/openmail"
  else
    DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/openmail"
  fi
fi
# Made absolute before the cd below, so a relative folder is relative to where you ran this.
[[ "$DATA_DIR" == /* ]] || DATA_DIR="$PWD/$DATA_DIR"
# Every CLI call below reads and writes this folder, and so do the commands this prints.
export OPENMAIL_HOME="$DATA_DIR"
printf -v RUN_CLI 'OPENMAIL_HOME=%q pnpm cli' "$DATA_DIR"

# OpenMail keeps client IDs in its own config.json (through the CLI).
cd "$(dirname "$0")/.."

CLI=(node --disable-warning=ExperimentalWarning packages/cli/dist/cli.js)
if [[ ! -f packages/cli/dist/cli.js ]]; then
  printf '%sRun pnpm build first. The wizard needs packages/cli/dist/cli.js.%s\n' "$RED" "$RESET"
  exit 1
fi

# configured google|microsoft: is a client already saved in config.json?
configured() {
  node -e '
    const fs = require("node:fs"), path = require("node:path");
    const file = path.join(process.env.OPENMAIL_HOME, "config.json");
    const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    process.exit(config[process.argv[1]] ? 0 : 1);
  ' "$1"
}

DO_GOOGLE=0
DO_MICROSOFT=0
_clear
printf '\n%s%s  OpenMail OAuth client setup%s\n\n' "$BOLD" "$BLUE" "$RESET"
say "OpenMail signs in with an OAuth client you register yourself. This wizard walks"
say "you through the Google Cloud and Azure consoles, then saves the client in"
say "OpenMail's config.json."
say "Data folder: $DATA_DIR"
if (( INSTALLED_APP_FOLDER )); then
  warn "This is the installed OpenMail's data folder. For a dev data folder, pass it:"
  warn "scripts/setup-oauth.sh \"\$HOME/OpenMail-dev\""
fi
printf '\n'
if configured google; then note "A Google client is already saved."; fi
if configured microsoft; then note "A Microsoft client is already saved."; fi
confirm "Register a Google client (Gmail)?" && DO_GOOGLE=1
confirm "Register a Microsoft client (personal outlook.com)?" && DO_MICROSOFT=1
if (( DO_GOOGLE + DO_MICROSOFT == 0 )); then
  say "Nothing selected. Exiting."
  exit 0
fi

TOTAL_STAGES=$(( DO_GOOGLE * 7 + DO_MICROSOFT * 5 ))

banner "OpenMail OAuth setup"

if (( DO_GOOGLE )); then
  stage "Google: create a project"
  say "Sign in to Google Cloud with the Gmail account you want to sync."
  open_url "https://console.cloud.google.com/projectcreate"
  step "Enter openmail as the Project name, keep the default Location, and click Create."
  step "When it is ready, switch to the openmail project in the project picker at the top."
  note "On every page after this one, check that openmail is the selected project."
  pause "Press Enter once the project exists and is selected"

  stage "Google: enable the Gmail API"
  open_url "https://console.cloud.google.com/apis/library/gmail.googleapis.com"
  step "Check that the project at the top is openmail, then click Enable."
  note "If the button says Manage, the API is already on. Continue."
  pause "Press Enter once it is enabled"

  stage "Google: branding"
  open_url "https://console.cloud.google.com/auth/branding"
  step "On your first visit the page shows Get started. Click it."
  step "Enter openmail as the App name and choose your address as User support email."
  step "Choose External as the Audience."
  step "Enter your address as Contact information, accept the terms, and click Create."
  pause "Press Enter when done"

  stage "Google: audience"
  open_url "https://console.cloud.google.com/auth/audience"
  say "In Testing, refresh tokens expire after 7 days and you sign in again every week."
  step "Under Publishing status, click Publish app and confirm. The status becomes In production."
  note "You do not need to submit for review. At sign-in Google warns that the app is"
  note "unverified. Click Advanced, then Continue."
  warn "If Publish app is greyed out, stay in Testing. Click Add users under Test users,"
  warn "type every Gmail address you want to sync, and click Save."
  pause "Press Enter once the status is In production or your test users are saved"

  stage "Google: data access"
  open_url "https://console.cloud.google.com/auth/scopes"
  step "Click Add or remove scopes."
  step "Add https://www.googleapis.com/auth/gmail.modify and https://www.googleapis.com/auth/gmail.send."
  step "Click Update, then Save."
  note "Optional services (calendar, contacts, Gmail settings) need more scopes."
  note "docs/setup-google.md lists them."
  pause "Press Enter once both scopes are saved"

  stage "Google: create a desktop client"
  open_url "https://console.cloud.google.com/auth/clients/create"
  step "Choose Desktop app as the Application type, enter openmail desktop as the Name, and click Create."
  step "The dialog shows the Client ID and Client secret. Download JSON keeps a copy."
  ask GOOGLE_CLIENT_ID "Paste the Client ID (it ends in .apps.googleusercontent.com):"
  while [[ "$GOOGLE_CLIENT_ID" != *.apps.googleusercontent.com ]]; do
    warn "That does not look right. The Client ID ends in .apps.googleusercontent.com."
    ask GOOGLE_CLIENT_ID "Paste the Client ID again:"
  done
  ask_secret GOOGLE_CLIENT_SECRET "Paste the Client secret (input is hidden):"
  while [[ -z "$GOOGLE_CLIENT_SECRET" ]]; do
    ask_secret GOOGLE_CLIENT_SECRET "The Client secret is empty. Paste it again:"
  done

  stage "Google: save and sign in to Gmail"
  "${CLI[@]}" config google --client-id "$GOOGLE_CLIENT_ID" --client-secret "$GOOGLE_CLIENT_SECRET"
  if confirm "Sign in to Gmail now? This opens Google's consent page"; then
    "${CLI[@]}" accounts add gmail || SKIPPED+=("Gmail sign-in failed. Run later: $RUN_CLI accounts add gmail")
  else
    SKIPPED+=("Sign in to Gmail: $RUN_CLI accounts add gmail, or add the account in the app")
  fi
  pause "Press Enter to continue"
fi

if (( DO_MICROSOFT )); then
  stage "Microsoft: register the app"
  say "Sign in with your personal Microsoft account (outlook.com, hotmail, live)."
  warn "A personal account needs an Entra directory first. If Azure says apps can no"
  warn "longer be created outside a directory, sign up for a free Azure account."
  warn "That creates a Default Directory."
  open_url "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade"
  step "Enter openmail as the Name."
  step "Under Supported account types, choose Personal Microsoft accounts only."
  step "Under Redirect URI, choose Public client/native (mobile & desktop) and enter http://localhost"
  step "Click Register."
  note "Azure rejects http://127.0.0.1. http://localhost matches any loopback port."
  pause "Press Enter once the app is registered"

  stage "Microsoft: copy the client ID"
  step "After registering you land on the Overview page. Copy the Application (client) ID."
  ask MICROSOFT_CLIENT_ID "Paste the Application (client) ID:"
  while [[ ! "$MICROSOFT_CLIENT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; do
    warn "That does not look right. It is a GUID, such as 1b2c3d4e-0000-1111-2222-333344445555."
    ask MICROSOFT_CLIENT_ID "Paste it again:"
  done

  stage "Microsoft: API permissions"
  step "In the sidebar, click API permissions, then Add a permission, Microsoft Graph, Delegated permissions."
  step "Select Mail.ReadWrite, Mail.Send, User.Read, offline_access and MailboxSettings.ReadWrite."
  step "Click Add permissions."
  note "User.Read is usually in the list already. Personal accounts need no admin consent."
  note "Optional services (contacts, calendar) need more permissions. docs/setup-microsoft.md lists them."
  pause "Press Enter once all five permissions are in the list"

  stage "Microsoft: public client"
  step "In the sidebar, click Authentication."
  step "Check that http://localhost is listed under Mobile and desktop applications."
  step "Set Allow public client flows to Yes and click Save."
  note "A public client uses PKCE and has no secret."
  pause "Press Enter once it is saved"

  stage "Microsoft: save and sign in to Outlook"
  "${CLI[@]}" config microsoft --client-id "$MICROSOFT_CLIENT_ID"
  if confirm "Sign in to Outlook now? This opens Microsoft's consent page"; then
    "${CLI[@]}" accounts add outlook || SKIPPED+=("Outlook sign-in failed. Run later: $RUN_CLI accounts add outlook")
  else
    SKIPPED+=("Sign in to Outlook: $RUN_CLI accounts add outlook, or add the account in the app")
  fi
  pause "Press Enter to continue"
fi

finish
"${CLI[@]}" accounts list || true
