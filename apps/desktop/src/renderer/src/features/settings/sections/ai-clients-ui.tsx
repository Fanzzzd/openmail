import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import type { AiSettings } from "@openmail/core/schema";
import { type ComponentType, Fragment } from "react";
import ClaudeIcon from "~icons/logos/claude-icon";
import CodexIcon from "~icons/logos/codex";
import CursorIcon from "~icons/logos/cursor-icon";
import ClaudeCodeIcon from "~icons/thesvg-color/claude-code";

import type { Account } from "../../../../../shared/api";
import { AiClientError, type AiClientId } from "../../../../../shared/ai-clients";
import { scrollBehavior } from "../../../lib/scroll-motion";

/**
 * Which accounts AI apps can read, from AiSettings. Until it loads, or when it fails, the pane
 * says so instead of "no account", so a settings or keychain error never reads as no consent.
 */
export type ReadableAccounts =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly accounts: readonly Account[] };
export function readableAccounts(
  settings: AsyncResult.AsyncResult<AiSettings, unknown>,
  accounts: readonly Account[],
): ReadableAccounts {
  if (AsyncResult.isFailure(settings)) return { kind: "failed" };
  if (!AsyncResult.isSuccess(settings)) return { kind: "loading" };
  const allowed = new Set(settings.value.accounts.filter((a) => a.allowed).map((a) => a.accountId));
  return {
    kind: "loaded",
    accounts: accounts.filter((a) => a.enabled !== false && allowed.has(a.id)),
  };
}

/** Anchors in the AI Access tab that the cards link to. */
export const CONSENT_ANCHOR = "ai-account-consent";
export const WRITE_MODE_ANCHOR = "ai-write-mode";
/** The setting that lets AI apps suggest changes, and its option that allows it. */
export const WRITE_MODE_NAME = msg`Changes by AI apps`;
export const ASK_FIRST = msg`Ask me first`;

export const CLIENTS: Record<
  AiClientId,
  { name: string; icon: ComponentType<{ className?: string }> }
> = {
  "claude-code": { name: "Claude Code", icon: ClaudeCodeIcon },
  codex: { name: "Codex", icon: CodexIcon },
  "claude-desktop": { name: "Claude", icon: ClaudeIcon },
  cursor: { name: "Cursor", icon: CursorIcon },
};

/** Which card an MCP client's initialize name belongs to. */
export function activityClient(name: string): AiClientId | null {
  if (/^claude-code/i.test(name)) return "claude-code";
  if (/codex/i.test(name)) return "codex";
  if (/^claude(-ai| desktop)?$/i.test(name)) return "claude-desktop";
  if (/cursor/i.test(name)) return "cursor";
  return null;
}

/** Paths in the person's home read shorter as ~/… */
export const homeShort = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/)/, "~");

/** A path in monospace that wraps only after a slash, never inside a folder name. */
export function PathText({ path }: { path: string }) {
  const parts = homeShort(path).split("/");
  return (
    <span className="font-mono">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <>
              /<wbr />
            </>
          )}
          {/* No break at the hyphens inside a folder name, only after a slash. */}
          <span className="whitespace-nowrap">{part}</span>
        </Fragment>
      ))}
    </span>
  );
}

export function scrollToAnchor(id: string) {
  const target = document.getElementById(id);
  target?.scrollIntoView({ block: "start", behavior: scrollBehavior() });
  target?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
}

export const RELOAD_HINTS = {
  "claude-code": msg`Start a new Claude Code session to load it.`,
  codex: msg`Start a new Codex session to load it.`,
  "claude-desktop": msg`Quit and reopen Claude to load it.`,
  cursor: msg`Restart Cursor to load it.`,
} as const;

export function clientErrorText(i18n: I18n, error: AiClientError): string {
  const detail = error.detail;
  switch (error.reason) {
    case "unreadable":
      return i18n._(
        msg`OpenMail can't read this config file, so it changes nothing. Fix the file, then try again. ${detail}`,
      );
    case "unsupportedLayout":
      return i18n._(
        msg`The openmail entry is written in a form OpenMail won't edit. Change it by hand. ${detail}`,
      );
    case "changed":
      return i18n._(msg`The file changed after the preview. Review the change again.`);
    case "cliFailed":
      return i18n._(msg`The app's command failed. Nothing else was changed. ${detail}`);
    case "notInstalled":
      return i18n._(msg`This app isn't installed.`);
    case "launchUnavailable":
      return i18n._(msg`OpenMail's MCP server can't start from here yet. See the note above.`);
    default:
      return i18n._(msg`Couldn't write the file. Nothing was changed. ${detail}`);
  }
}

export const failureText = (i18n: I18n, cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  return error._tag === "Some" && error.value instanceof AiClientError
    ? clientErrorText(i18n, error.value)
    : i18n._(msg`Something went wrong. Try again.`);
};

const codeBase =
  "max-h-48 rounded-control bg-fill-quiet px-2.5 py-2 font-mono text-footnote select-text";
export const codeBlock = `${codeBase} overflow-auto whitespace-pre`;
/** Every character of a command the person approves stays visible: long lines wrap. */
export const wrappedCode = `${codeBase} overflow-y-auto break-all whitespace-pre-wrap`;
