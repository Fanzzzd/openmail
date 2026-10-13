import { useLingui } from "@lingui/react/macro";
import { systemFolderId, type LabelPreference } from "@openmail/core/schema";
import { Effect } from "effect";
import { Reactivity } from "effect/reactivity";
import { useState, type ButtonHTMLAttributes } from "react";
import type { Account, Label, Mailbox } from "../../../../shared/api";
import { accountName } from "../../lib/format";
import { MAILBOX_NAMES, type scopeAccountIds, type View } from "../../lib/view";
import { Keys, MAIL_KEYS } from "../../state/keys";
import { type MailEnv, useRunMail, withMail } from "../../state/mail";
import {
  DragLabel,
  DragMessages,
  FAVORITE_DRAG,
  LABEL_DRAG,
  MESSAGE_DRAG,
  decodeDrag,
  sidebarDropOperation,
} from "../organize";
import { numberedFavorites } from "./favorite-navigation";

/**
 * Favorites, drag and drop and label nesting in the sidebar. Every change goes through
 * `perform`, which refreshes mail views and reports a failure under the sidebar.
 */
export function useSidebarOrganize({
  view,
  accounts,
  members,
  scope,
  labelPrefs,
  favoriteLabels,
}: {
  view: View;
  accounts: readonly Account[];
  members: readonly Account[];
  scope: ReturnType<typeof scopeAccountIds>;
  labelPrefs: readonly LabelPreference[];
  favoriteLabels: readonly Label[];
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [dragAccount, setDragAccount] = useState<string | null>(null);
  const [organizeError, setOrganizeError] = useState("");
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const named = numberedFavorites(view, accounts, favoriteLabels, labelPrefs).map((p) => {
    const custom = favoriteLabels.find((l) => l.accountId === p.accountId && l.id === p.id);
    return { ...p, name: p.mailbox ? i18n._(MAILBOX_NAMES[p.mailbox]) : (custom?.name ?? p.id) };
  });
  // Inbox favorited in two accounts shows twice; the account tells the rows apart.
  const favorites = named.map((p) => {
    if (named.filter((other) => other.name === p.name).length < 2) return p;
    const account = accounts.find((a) => a.id === p.accountId);
    const owner = account ? accountName(account) : p.accountId;
    const name = p.name;
    return { ...p, name: t`${name} (${owner})` };
  });
  const perform = <A, E>(effect: Effect.Effect<A, E, MailEnv>) =>
    run(
      effect.pipe(
        Reactivity.mutation(MAIL_KEYS),
        Effect.catchCause(() => Effect.sync(() => setOrganizeError(t`Action failed`))),
      ),
    );
  const isFavorite = (accountId: string, id: string) =>
    labelPrefs.some((p) => p.accountId === accountId && p.id === id && p.favorite);
  /**
   * Favorites belong to one account's folder. In All accounts a mailbox's star covers every
   * account in the space: on when all of them have it, and pressing it sets all of them.
   */
  const favoriteAccounts = view.accountId
    ? [view.accountId]
    : members.filter((a) => a.enabled !== false).map((a) => a.id);
  const setFavorite = (targets: readonly { accountId: string; id: string }[], on: boolean) => {
    const last = Math.max(-1, ...labelPrefs.map((p) => p.position ?? 0));
    const changes = targets
      .filter((target) => isFavorite(target.accountId, target.id) !== on)
      .map(({ accountId, id }, index) => ({
        ...(labelPrefs.find((p) => p.accountId === accountId && p.id === id) ?? {
          accountId,
          id,
          visible: true,
          color: null,
        }),
        favorite: on,
        position: last + 1 + index,
      }));
    if (changes.length)
      perform(
        Effect.forEach(
          changes,
          (input) => withMail((call) => call("SetLabelPreference", { input })),
          { discard: true },
        ),
      );
  };
  const toggleFavorite = (accountId: string, id: string) =>
    setFavorite([{ accountId, id }], !isFavorite(accountId, id));
  const mailboxFavorite = (mailbox: Mailbox) => {
    const id = systemFolderId(mailbox);
    const targets = favoriteAccounts.map((accountId) => ({ accountId, id }));
    const on = targets.length > 0 && targets.every((target) => isFavorite(target.accountId, id));
    return { on, toggle: () => setFavorite(targets, !on), allAccounts: !view.accountId };
  };
  const resetFavorites = () =>
    run(
      withMail((call) =>
        call("ResetFavorites", { accountIds: scope ?? members.map((a) => a.id) }),
      ).pipe(
        Reactivity.mutation([Keys.organization]),
        Effect.match({
          onSuccess: () => setFavoriteError(null),
          onFailure: (error) => setFavoriteError(error.message),
        }),
      ),
    );
  const reorder = (
    source: { accountId: string; id: string },
    target: { accountId: string; id: string },
  ) => {
    const from = favorites.findIndex((f) => f.accountId === source.accountId && f.id === source.id);
    const to = favorites.findIndex((f) => f.accountId === target.accountId && f.id === target.id);
    if (from < 0 || to < 0 || from === to) return;
    const ordered = [...favorites];
    const moved = ordered.splice(from, 1)[0];
    if (!moved) return;
    ordered.splice(to, 0, moved);
    perform(
      withMail((call) =>
        call("ReorderFavorites", {
          order: ordered.map((f) => ({ accountId: f.accountId, id: f.id })),
        }),
      ),
    );
  };
  const drop = (
    event: React.DragEvent<HTMLButtonElement>,
    target: { accountId: string; id: string },
    parent: boolean,
  ) => {
    event.preventDefault();
    const favorite = decodeDrag(DragLabel, event.dataTransfer.getData(FAVORITE_DRAG));
    if (favorite) {
      reorder(favorite, target);
      return;
    }
    const label = decodeDrag(DragLabel, event.dataTransfer.getData(LABEL_DRAG));
    if (label) {
      if (label.id.startsWith("category:") || target.id.startsWith("category:")) return;
      if (parent && label.accountId === target.accountId)
        perform(
          withMail((call) =>
            call("ChangeLabel", {
              accountId: label.accountId,
              change: { kind: "parent", id: label.id, parentId: target.id },
            }),
          ),
        );
      return;
    }
    const messages = decodeDrag(DragMessages, event.dataTransfer.getData(MESSAGE_DRAG));
    if (messages) {
      const op = sidebarDropOperation(target.id, messages.removeLabelId);
      if (!op) return;
      const ids = messages.ids.filter((id) => id.startsWith(`${target.accountId}/`));
      if (ids.length)
        perform(
          withMail((call) =>
            call("ModifyWithUndo", {
              threads: ids,
              op,
              flat: messages.flat,
            }),
          ).pipe(Effect.asVoid),
        );
    }
  };
  const unnest = (label: Label) =>
    perform(
      withMail((call) =>
        call("ChangeLabel", {
          accountId: label.accountId,
          change: { kind: "parent", id: label.id, parentId: null },
        }),
      ),
    );
  const labelActions = (l: Label): ButtonHTMLAttributes<HTMLButtonElement> => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(LABEL_DRAG, JSON.stringify({ accountId: l.accountId, id: l.id }));
      e.dataTransfer.effectAllowed = "move";
      setDragAccount(l.accountId);
    },
    onDragEnd: () => setDragAccount(null),
    onDragOver: (e) => {
      if ([MESSAGE_DRAG, LABEL_DRAG].some((type) => e.dataTransfer.types.includes(type)))
        e.preventDefault();
    },
    onDrop: (e) => drop(e, l, true),
  });
  return {
    favorites,
    perform,
    isFavorite,
    favoriteAccounts,
    toggleFavorite,
    mailboxFavorite,
    resetFavorites,
    reorder,
    drop,
    unnest,
    labelActions,
    dragAccount,
    setDragAccount,
    organizeError,
    favoriteError,
  };
}
