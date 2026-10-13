import { isDesktop } from "../../lib/platform";
import {
  useState,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
  useRef,
} from "react";
import { useLingui, Trans } from "@lingui/react/macro";
import { numberedFavorites, favoriteView } from "./favorite-navigation";
import { DEFAULT_PREFS, specialFolderBadge, systemFolderId } from "@openmail/core/schema";
import { Effect } from "effect";
import {
  MESSAGE_DRAG,
  LABEL_DRAG,
  FAVORITE_DRAG,
  DragMessages,
  DragLabel,
  sidebarDropOperation,
  decodeDrag,
} from "../organize";
import { MAIL_KEYS, Keys } from "../../state/keys";
import { Toolbar } from "@base-ui/react/toolbar";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Reactivity } from "effect/reactivity";
import {
  ArrowRight,
  Bookmark,
  ChevronDown,
  ChevronRight,
  File,
  Inbox,
  Clock,
  Info,
  Layers,
  LayoutGrid,
  Mails,
  MessagesSquare,
  PanelLeft,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  SquarePen,
  Star,
  Tag,
  Trash2,
  User,
  Users,
} from "lucide-react";

import type {
  Account,
  Label,
  Mailbox,
  Profile,
  SyncProgress,
  SyncState,
} from "../../../../shared/api";
import {
  accountName,
  accountColorClass,
  accountColorStyle,
  accountColorValue,
  PROFILE_BG,
} from "../../lib/format";
import { type MailEnv, withMail, syncNow, useRunMail } from "../../state/mail";
import { SidebarAccountIssues, SyncStatusAnnouncement, syncFailures } from "../sync-status";
import {
  prefsAtom,
  labelsAtom,
  labelPreferencesAtom,
  organizationAtom,
  unreadByLabelAtom,
} from "../../state/queries";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import { ProviderIcon } from "../../ui/ProviderIcon";
import {
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "../../ui/Menu";
import { iconButton, titlebarRow } from "../../ui/styles";
import { Tip } from "../../ui/Tip";
import { TrafficLightSpace } from "../../ui/TrafficLights";
import {
  ALL,
  inboxCategoryNames,
  categoryAccounts,
  MAILBOX_NAMES,
  OVERVIEW,
  scopeAccountIds,
  type SpaceId,
  spaceAccounts,
  type View,
} from "../../lib/view";

type Icon = ComponentType<{ className?: string }>;

// Each mailbox gets its own icon color, as in Mimestream's sidebar.
export const MAILBOXES: { id: Mailbox; icon: Icon; color: string }[] = [
  { id: "snoozed", icon: Clock, color: "text-violet-600 dark:text-violet-400" },
  { id: "inbox", icon: Inbox, color: "text-blue-600 dark:text-blue-400" },
  { id: "important", icon: Bookmark, color: "text-orange-600 dark:text-orange-400" },
  { id: "starred", icon: Star, color: "text-amber-600 dark:text-amber-400" },
  { id: "sent", icon: Send, color: "text-emerald-600 dark:text-emerald-400" },
  { id: "drafts", icon: File, color: "text-sky-600 dark:text-sky-400" },
  { id: "spam", icon: ShieldAlert, color: "text-orange-600 dark:text-orange-400" },
  { id: "trash", icon: Trash2, color: "text-red-600 dark:text-red-400" },
  { id: "all", icon: Mails, color: "text-violet-600 dark:text-violet-400" },
];

const CATEGORY_ICONS: Record<string, Icon> = {
  CATEGORY_PERSONAL: User,
  CATEGORY_SOCIAL: Users,
  CATEGORY_PROMOTIONS: Tag,
  CATEGORY_UPDATES: Info,
  CATEGORY_FORUMS: MessagesSquare,
};

const NO_COUNTS: Readonly<Record<string, number>> = {};

/**
 * Unread counts by label in the accounts the view's mailboxes cover, for
 * their badges; with `within`, only of mail that also has that label.
 */
export function useMailboxCounts(view: View, accounts: readonly Account[], within?: string) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const scope = scopeAccountIds({ ...view, label: undefined }, accounts);
  return AsyncResult.getOrElse(
    useAtomValue(unreadByLabelAtom(scope, within, prefs?.threadGrouping !== false)),
    () => NO_COUNTS,
  );
}

/** The shortcut that opens the space at `index` among the user's spaces, for the first nine. */
export function spaceShortcutLabel(shortcutSet: string, index: number) {
  return index < 9 ? `${shortcutSet === "gmail" ? "⌘" : "⌃⌘"}${index + 1}` : undefined;
}

interface Props {
  view: View;
  onView: (v: View) => void;
  onSpace: (space: SpaceId) => void;
  onEditProfile: (profile: Profile | "new") => void;
  accounts: readonly Account[];
  profiles: readonly Profile[];
  unread: Readonly<Record<string, number>>;
  actions?: (label: Label) => ButtonHTMLAttributes<HTMLButtonElement>;
  favorite?: (label: Label) => void;
  syncState: SyncState;
  progress: SyncProgress | null;
  proposals: number;
  onAddAccount: () => void;
  onCompose: () => void;
  onReauth: (account: Account) => void;
  onProposals: () => void;
  onSettings: () => void;
}

export function Sidebar({
  view,
  onView,
  onSpace,
  onEditProfile,
  accounts,
  profiles,
  unread,
  syncState,
  progress,
  proposals,
  onAddAccount,
  onCompose,
  onReauth,
  onProposals,
  onSettings,
}: Props) {
  const [categoriesOpen, setCategoriesOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dragAccount, setDragAccount] = useState<string | null>(null);
  const [organizeError, setOrganizeError] = useState("");
  const run = useRunMail();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();
  const favoriteMenuText = useFavoriteMenuText();

  const members = spaceAccounts(view.space, accounts);
  const scope = scopeAccountIds({ ...view, label: undefined }, accounts);
  const byLabel = useMailboxCounts(view, accounts);
  const inInbox = useMailboxCounts(view, accounts, "INBOX");
  const labelPrefs = AsyncResult.getOrElse(useAtomValue(labelPreferencesAtom), () => []);
  const organization = AsyncResult.getOrElse(useAtomValue(organizationAtom), () => []);
  const favoriteLabels = AsyncResult.getOrElse(
    useAtomValue(labelsAtom(scopeAccountIds({ space: view.space, mailbox: "all" }, accounts))),
    () => [],
  );
  const allLabels = AsyncResult.getOrElse(useAtomValue(labelsAtom(scope)), () => []);
  const colored = allLabels.map((l) => ({
    ...l,
    color:
      labelPrefs.find((p) => p.accountId === l.accountId && p.id === l.id)?.color ??
      l.color ??
      accounts.filter((a) => a.id === l.accountId).map(accountColorValue)[0] ??
      null,
  }));
  const visible = (l: Label) => {
    const local = labelPrefs.find((p) => p.accountId === l.accountId && p.id === l.id);
    if (l.labelListVisibility)
      return (
        l.labelListVisibility === "labelShow" ||
        (l.labelListVisibility === "labelShowIfUnread" && (byLabel[l.id] ?? 0) > 0)
      );
    return local?.visible !== false;
  };
  const categories = colored.filter((label) => label.id.startsWith("category:"));
  const labels = colored.filter((label) => !label.id.startsWith("category:") && visible(label));
  const hidden = colored.filter((l) => !l.id.startsWith("category:") && !visible(l));
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
  const profile = profiles.find((p) => p.id === view.space);
  const categorized = categoryAccounts({ ...view, label: undefined }, accounts);
  const categoryNames = inboxCategoryNames(
    categorized.length > 0 && categorized.every((a) => a.provider === "outlook"),
  );
  const hasCategories = categorized.some(
    (account) => organization.find((o) => o.accountId === account.id)?.categories !== false,
  );
  const spaceUnread = members.reduce((n, a) => n + (unread[a.id] ?? 0), 0);

  const failures = syncFailures(accounts, syncState);
  /** The footer line: progress while syncing, then failures or the last sync time. */
  const syncStatus = () => {
    if (syncState.running) {
      if (!progress) return t`Syncing…`;
      const fetched = i18n.number(progress.fetched),
        total = i18n.number(progress.total);
      return t`Syncing ${fetched}/${total}`;
    }
    if (failures.length) {
      const count = i18n.number(failures.length);
      return t`Sync failed (${count})`;
    }
    if (!syncState.lastFinishedAt) return "";
    const time = new Date(syncState.lastFinishedAt).toLocaleTimeString(i18n.locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
    return t`Synced ${time}`;
  };

  return (
    <aside
      onDropCapture={() => setDragAccount(null)}
      onDragEndCapture={() => setDragAccount(null)}
      className="@container/sidebar flex h-full w-full flex-col bg-neutral-100/60 dark:bg-neutral-950/70"
    >
      <div className={`${titlebarRow} justify-end gap-0.5 px-3`}>
        <TrafficLightSpace className="me-auto" />
        {/* Signing in opens the Mac's browser and keychain: desktop only. */}
        {isDesktop() && (
          <Tip label={t`Add email account`}>
            <button
              type="button"
              aria-label={t`Add email account`}
              onClick={onAddAccount}
              className="rounded-control p-1 text-a11y-muted hover:bg-fill-hover"
            >
              <Plus className="size-4.5" />
            </button>
          </Tip>
        )}
        <Tip label={t`New message`} shortcut={shortcut("compose")}>
          <button
            type="button"
            aria-label={t`New message`}
            onClick={onCompose}
            className="rounded-control p-1 text-a11y-muted hover:bg-fill-hover"
          >
            <SquarePen className="size-4.5" />
          </button>
        </Tip>
      </div>

      <div className="flex items-center gap-2 px-4.5 pb-3">
        <span className="min-w-0 flex-1 truncate text-headline font-semibold">
          {profile ? `${profile.icon} ${profile.name}` : <Trans>All accounts</Trans>}
        </span>
        {profile && (
          <Tip label={t`Edit space`}>
            <button
              type="button"
              aria-label={t`Edit space`}
              onClick={() => onEditProfile(profile)}
              className={`text-a11y-muted ${iconButton}`}
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>

      <nav aria-label={t`Mailboxes`} className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {members.length > 1 && (
          <div className="mb-4 grid gap-1 @min-[240px]/sidebar:grid-cols-2 @min-[240px]/sidebar:gap-1.5">
            <Tile
              active={!view.accountId}
              onClick={() => onView({ ...view, accountId: undefined, label: undefined })}
              icon={
                <span className="flex size-6 items-center justify-center rounded-full bg-neutral-500 text-white">
                  <Layers className="size-3.5" />
                </span>
              }
              label={t`All`}
              title={t`All accounts in this space`}
              badge={spaceUnread}
            />
            {members.map((a) => (
              <Tile
                key={a.id}
                active={view.accountId === a.id}
                onClick={() => onView({ ...view, accountId: a.id, label: undefined })}
                icon={<AccountAvatar account={a} />}
                label={accountName(a)}
                sublabel={a.needsReauth ? t`Needs sign-in` : a.email.split("@")[1]}
                warn={a.needsReauth}
                title={a.email}
                badge={unread[a.id] ?? 0}
              />
            ))}
          </div>
        )}
        {members.length === 0 && (
          <p className="px-2 pb-4 text-footnote leading-relaxed text-a11y-muted">
            {profile ? (
              <Trans>
                This space has no accounts yet.{" "}
                <button
                  type="button"
                  onClick={() => onEditProfile(profile)}
                  className="text-a11y-accent dark:text-blue-400"
                >
                  Add account
                </button>
              </Trans>
            ) : (
              <Trans>This space has no accounts yet.</Trans>
            )}
          </p>
        )}
        <SidebarAccountIssues
          members={members}
          failures={failures}
          onReauth={onReauth}
          className="mx-1 mb-3"
        />

        {proposals > 0 && (
          <div className="mb-4">
            <Item
              active={false}
              onClick={onProposals}
              icon={<Sparkles className="size-4.5 text-violet-600 dark:text-violet-400" />}
              label={t`AI suggestions`}
              badge={proposals}
            />
          </div>
        )}

        {/* No account, no mailboxes: the window offers Add account instead. */}
        {members.length > 0 && (
          <>
            <ContextMenuRoot>
              <ContextMenuTrigger render={<div />}>
                <Section title={t`Mailboxes`}>
                  {MAILBOXES.map(({ id, icon: Icon, color }) => {
                    const favorite = mailboxFavorite(id);
                    const mailboxName = i18n._(MAILBOX_NAMES[id]);
                    return (
                      <div key={id}>
                        <ContextMenuRoot>
                          <ContextMenuTrigger
                            render={<div onKeyDownCapture={openMenuFromKeyboard} />}
                          >
                            <Item
                              buttonProps={{
                                onDragOver: (e) => {
                                  if (
                                    e.dataTransfer.types.includes(MESSAGE_DRAG) &&
                                    ["inbox", "trash", "spam"].includes(id)
                                  )
                                    e.preventDefault();
                                },
                                onDrop: (e) => {
                                  e.preventDefault();
                                  const messages = decodeDrag(
                                    DragMessages,
                                    e.dataTransfer.getData(MESSAGE_DRAG),
                                  );
                                  if (
                                    messages &&
                                    (id === "inbox" || id === "trash" || id === "spam")
                                  )
                                    perform(
                                      withMail((call) =>
                                        call("ModifyWithUndo", {
                                          threads: messages.ids,
                                          op: { kind: id },
                                          flat: messages.flat,
                                        }),
                                      ).pipe(Effect.asVoid),
                                    );
                                },
                              }}
                              active={view.mailbox === id && !view.label}
                              onClick={() => onView({ ...view, mailbox: id, label: undefined })}
                              icon={<Icon className={`size-4.5 ${color}`} />}
                              label={i18n._(MAILBOX_NAMES[id])}
                              badge={specialFolderBadge(
                                id,
                                byLabel,
                                prefs?.specialFolderBadges ?? DEFAULT_PREFS.specialFolderBadges,
                              )}
                              disclosure={
                                <>
                                  {favoriteAccounts.length > 0 && (
                                    <FavoriteStar
                                      name={mailboxName}
                                      pressed={favorite.on}
                                      allAccounts={favorite.allAccounts}
                                      onToggle={favorite.toggle}
                                    />
                                  )}
                                  {id === "inbox" && hasCategories ? (
                                    <button
                                      type="button"
                                      aria-label={
                                        categoriesOpen
                                          ? t`Collapse categories`
                                          : t`Expand categories`
                                      }
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setCategoriesOpen((v) => !v);
                                      }}
                                      className="-ml-1 rounded p-0.5 text-a11y-muted hover:bg-fill-hover"
                                    >
                                      {categoriesOpen ? (
                                        <ChevronDown className="size-3.5" />
                                      ) : (
                                        <ChevronRight className="size-3.5" />
                                      )}
                                    </button>
                                  ) : undefined}
                                </>
                              }
                            />
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            {favoriteAccounts.length > 0 && (
                              <MenuItem icon={Star} onClick={favorite.toggle}>
                                {favoriteMenuText(favorite.on, favorite.allAccounts)}
                              </MenuItem>
                            )}
                            <MenuItem onClick={resetFavorites}>{t`Reset favorites`}</MenuItem>
                          </ContextMenuContent>
                        </ContextMenuRoot>
                        {id === "inbox" &&
                          hasCategories &&
                          categoriesOpen &&
                          Object.entries(categoryNames)
                            .filter(([category]) =>
                              accounts.some(
                                (a) =>
                                  a.enabled !== false &&
                                  (a.provider === "gmail" || a.provider === "outlook") &&
                                  (!scope || scope.includes(a.id)) &&
                                  (a.provider === "outlook"
                                    ? ["CATEGORY_PERSONAL", "CATEGORY_OTHER"].includes(category)
                                    : category !== "CATEGORY_OTHER") &&
                                  organization.find((o) => o.accountId === a.id)?.categories !==
                                    false &&
                                  (organization
                                    .find((o) => o.accountId === a.id)
                                    ?.selectedCategories?.some((c) => c === category) ??
                                    true),
                              ),
                            )
                            .map(([cat, name]) => {
                              const CatIcon = CATEGORY_ICONS[cat] ?? Tag;
                              return (
                                <Item
                                  key={cat}
                                  indent
                                  active={view.mailbox === "inbox" && view.label?.id === cat}
                                  onClick={() =>
                                    onView({ ...view, mailbox: "inbox", label: { id: cat } })
                                  }
                                  icon={
                                    <CatIcon className="size-4 text-blue-600 dark:text-blue-400" />
                                  }
                                  label={i18n._(name)}
                                  badge={inInbox[cat] ?? 0}
                                />
                              );
                            })}
                      </div>
                    );
                  })}
                </Section>

                {favorites.length > 0 && (
                  <Section title={t`Favorites`}>
                    {favorites.map((l, index) => (
                      <Item
                        key={`${l.accountId}/${l.id}`}
                        buttonProps={{
                          draggable: true,
                          onDragStart: (e) =>
                            e.dataTransfer.setData(
                              FAVORITE_DRAG,
                              JSON.stringify({ accountId: l.accountId, id: l.id }),
                            ),
                          onDragOver: (e) => e.preventDefault(),
                          onDrop: (e) => drop(e, l, false),
                        }}
                        disclosure={
                          <>
                            <button
                              type="button"
                              aria-label={t`Move up`}
                              disabled={index === 0}
                              onClick={() => {
                                const target = favorites[index - 1];
                                if (target) reorder(l, target);
                              }}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              aria-label={t`Move down`}
                              disabled={index === favorites.length - 1}
                              onClick={() => {
                                const target = favorites[index + 1];
                                if (target) reorder(l, target);
                              }}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              aria-label={t`Remove favorite`}
                              onClick={() => toggleFavorite(l.accountId, l.id)}
                            >
                              ×
                            </button>
                          </>
                        }
                        active={
                          l.mailbox
                            ? view.mailbox === l.mailbox &&
                              view.accountId === l.accountId &&
                              !view.label
                            : view.label?.id === l.id && view.label.accountId === l.accountId
                        }
                        onClick={() => onView(favoriteView(view, l))}
                        icon={<Star className="size-4 text-amber-600 dark:text-amber-400" />}
                        label={index < 9 ? `${l.name}  ⌥⌘${index + 1}` : l.name}
                        badge={0}
                      />
                    ))}
                  </Section>
                )}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <MenuItem onClick={resetFavorites}>{t`Reset favorites`}</MenuItem>
              </ContextMenuContent>
            </ContextMenuRoot>
            {favoriteError && (
              <output role="alert" className="px-3 text-footnote text-a11y-danger">
                {favoriteError}
              </output>
            )}
            <LabelSections
              labels={labels}
              accounts={accounts}
              view={view}
              onView={onView}
              unread={byLabel}
              actions={labelActions}
              unnest={unnest}
              favorite={(l) => toggleFavorite(l.accountId, l.id)}
              isFavorite={(l) => isFavorite(l.accountId, l.id)}
            />
            {categories.length > 0 && (
              <LabelSections
                labels={categories}
                accounts={accounts}
                view={view}
                onView={onView}
                unread={byLabel}
                categories
                actions={(label) => ({
                  onDragOver: (event) => {
                    if (event.dataTransfer.types.includes(MESSAGE_DRAG)) event.preventDefault();
                  },
                  onDrop: (event) => drop(event, label, false),
                })}
              />
            )}
            {hidden.length > 0 && (prefs?.showMore ?? true) && (
              <>
                <button
                  type="button"
                  aria-expanded={moreOpen}
                  className="px-2 py-1 text-callout"
                  onClick={() => setMoreOpen(!moreOpen)}
                >{t`More`}</button>
                {moreOpen && (
                  <LabelSections
                    labels={hidden}
                    accounts={accounts}
                    view={view}
                    onView={onView}
                    unread={byLabel}
                    actions={labelActions}
                    unnest={unnest}
                  />
                )}
              </>
            )}
          </>
        )}
        {organizeError && <p role="alert">{organizeError}</p>}
        {members
          .filter((a) => a.id === dragAccount)
          .map((a) => (
            <button
              key={a.id}
              type="button"
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(LABEL_DRAG)) e.preventDefault();
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragAccount(null);
                const label = decodeDrag(DragLabel, e.dataTransfer.getData(LABEL_DRAG));
                if (label?.accountId === a.id)
                  perform(
                    withMail((call) =>
                      call("ChangeLabel", {
                        accountId: a.id,
                        change: { kind: "parent", id: label.id, parentId: null },
                      }),
                    ),
                  );
              }}
              className="my-2 block rounded-control border-2 border-dashed border-blue-400 bg-blue-50 px-3 py-2 text-footnote text-blue-800 dark:bg-blue-950 dark:text-blue-200"
            >
              {t`No parent`} · {accountName(a)}
            </button>
          ))}
      </nav>

      <footer className="flex items-center gap-2 px-4 py-2 text-footnote text-a11y-muted">
        {/* With no account there is nothing to sync, so the footer keeps only Settings. */}
        <span className="line-clamp-2 min-w-0 flex-1" title={failures.join("\n")}>
          {/* Readable on mount too: the announcement below stays silent until the state changes. */}
          {accounts.length > 0 && (
            <>
              <span>{syncStatus()}</span>
              <SyncStatusAnnouncement failed={failures.length > 0} />
            </>
          )}
        </span>
        <Tip label={t`Settings`} shortcut={shortcut("settings")} side="top">
          <button
            type="button"
            aria-label={t`Settings`}
            onClick={onSettings}
            className="rounded p-1 hover:bg-fill-hover"
          >
            <SettingsIcon className="size-3.5" />
          </button>
        </Tip>
        {accounts.length > 0 && (
          <Tip label={t`Sync now`} shortcut={shortcut("sync")} side="top">
            <button
              type="button"
              aria-label={t`Sync now`}
              onClick={() => run(syncNow)}
              className="rounded p-1 hover:bg-fill-hover"
            >
              <RefreshCw className={`size-3.5 ${syncState.running ? "animate-spin" : ""}`} />
            </button>
          </Tip>
        )}
      </footer>

      <SpaceSwitcher
        space={view.space}
        profiles={profiles}
        onSpace={onSpace}
        onEditProfile={onEditProfile}
      />
    </aside>
  );
}

/** Brings back the sidebar when it is hidden or, in a narrow window, opens it as a drawer. */
export function SidebarToggle({ onClick }: { onClick: () => void }) {
  const { t } = useLingui();
  const shortcut = useShortcutText();
  return (
    <Tip label={t`Show sidebar`} shortcut={shortcut("toggleSidebar")}>
      <button
        type="button"
        aria-label={t`Show sidebar`}
        onClick={onClick}
        className={`shrink-0 text-a11y-muted ${iconButton}`}
      >
        <PanelLeft className="size-4.5" />
      </button>
    </Tip>
  );
}

const ring = (active: boolean) =>
  active ? "bg-white shadow-sm ring-1 ring-edge dark:bg-white/15" : "hover:bg-fill-hover";

const cell = (active: boolean) =>
  `flex size-8 shrink-0 items-center justify-center rounded-card outline-offset-0 outline-a11y-focus focus-visible:outline-[3px] ${ring(active)}`;

/** Arc-style row of spaces at the bottom of the sidebar. ⌃1 is the overview. */
function SpaceSwitcher({
  space,
  profiles,
  onSpace,
  onEditProfile,
}: {
  space: SpaceId;
  profiles: readonly Profile[];
  onSpace: (space: SpaceId) => void;
  onEditProfile: (profile: Profile | "new") => void;
}) {
  const { t } = useLingui();
  const shortcutSet = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => ({
    shortcutSet: "mimestream",
  })).shortcutSet;
  const [menuFor, setMenuFor] = useState<Profile | null>(null);
  /** The space under the pointer at the right-click, set before the menu opens. */
  const pressed = useRef<Profile | null>(null);
  return (
    <Toolbar.Root
      aria-label={t`Spaces`}
      className="flex items-center gap-1 overflow-x-auto border-t border-separator px-2.5 py-2"
    >
      <Tip label={t`Overview`} shortcut="⌃1" side="top">
        <Toolbar.Button
          aria-label={t`Overview`}
          aria-current={space === OVERVIEW || undefined}
          onClick={() => onSpace(OVERVIEW)}
          className={`${cell(space === OVERVIEW)} text-neutral-600 dark:text-neutral-300`}
        >
          <LayoutGrid className="size-4" />
        </Toolbar.Button>
      </Tip>
      <Tip label={t`All accounts`} shortcut="⌃2" side="top">
        <Toolbar.Button
          aria-label={t`All accounts`}
          aria-current={space === ALL || undefined}
          onClick={() => onSpace(ALL)}
          className={`${cell(space === ALL)} text-neutral-600 dark:text-neutral-300`}
        >
          <Layers className="size-4" />
        </Toolbar.Button>
      </Tip>
      {profiles.length > 0 && (
        <Toolbar.Separator className="mx-0.5 h-5 w-px shrink-0 bg-fill-pressed" />
      )}
      <ContextMenuRoot
        onOpenChange={(open, details) => {
          if (!open) return;
          if (pressed.current) setMenuFor(pressed.current);
          else details.cancel();
        }}
        onOpenChangeComplete={(open) => {
          if (!open) setMenuFor(null);
        }}
      >
        <ContextMenuTrigger
          render={
            <span
              className="flex items-center gap-1"
              onContextMenuCapture={() => {
                pressed.current = null;
              }}
            />
          }
        >
          {profiles.map((p, i) => (
            <Tip key={p.id} label={p.name} shortcut={spaceShortcutLabel(shortcutSet, i)} side="top">
              <Toolbar.Button
                aria-label={p.name}
                aria-current={space === p.id || undefined}
                onClick={() => onSpace(p.id)}
                onContextMenu={() => {
                  pressed.current = p;
                }}
                className={cell(space === p.id)}
              >
                <span
                  className={`flex size-6 items-center justify-center rounded-full text-body ${PROFILE_BG[p.color]}`}
                >
                  {p.icon}
                </span>
              </Toolbar.Button>
            </Tip>
          ))}
        </ContextMenuTrigger>
        {menuFor && (
          <ContextMenuContent>
            <MenuItem icon={Pencil} onClick={() => onEditProfile(menuFor)}>
              {t`Edit space`}
            </MenuItem>
            <MenuItem icon={ArrowRight} onClick={() => onSpace(menuFor.id)}>
              {t`Open space`}
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Plus} onClick={() => onEditProfile("new")}>
              {t`New space`}
            </MenuItem>
          </ContextMenuContent>
        )}
      </ContextMenuRoot>
      <Tip label={t`New space`} side="top">
        <Toolbar.Button
          aria-label={t`New space`}
          onClick={() => onEditProfile("new")}
          className={`${cell(false)} text-a11y-muted`}
        >
          <Plus className="size-4" />
        </Toolbar.Button>
      </Tip>
    </Toolbar.Root>
  );
}

function LabelSections({
  labels,
  accounts,
  view,
  onView,
  unread,
  actions,
  favorite,
  isFavorite = () => false,
  unnest,
  categories = false,
}: {
  unnest?: (label: Label) => void;
  isFavorite?: (label: Label) => boolean;
  categories?: boolean;
  labels: readonly Label[];
  accounts: readonly Account[];
  view: View;
  onView: (v: View) => void;
  unread: Readonly<Record<string, number>>;
  actions?: (label: Label) => ButtonHTMLAttributes<HTMLButtonElement>;
  favorite?: (label: Label) => void;
}) {
  const { t } = useLingui();
  const favoriteMenuText = useFavoriteMenuText();
  const groups = new Map<string, Label[]>();
  for (const l of labels) groups.set(l.accountId, [...(groups.get(l.accountId) ?? []), l]);
  return [...groups].map(([accountId, list]) => {
    const account = accounts.find((a) => a.id === accountId);
    const email = account ? accountName(account) : accountId;
    return (
      <Section
        key={accountId}
        title={categories ? t`Outlook categories` : groups.size > 1 ? email : t`Labels`}
      >
        {list.map((l) => (
          <ContextMenuRoot key={l.id}>
            <ContextMenuTrigger
              render={
                <div
                  onKeyDownCapture={
                    favorite || (unnest && l.name.includes("/")) ? openMenuFromKeyboard : undefined
                  }
                />
              }
            >
              <Item
                buttonProps={actions?.(l)}
                disclosure={
                  favorite && (
                    <FavoriteStar
                      name={l.name}
                      pressed={isFavorite(l)}
                      allAccounts={false}
                      onToggle={() => favorite(l)}
                    />
                  )
                }
                active={view.label?.id === l.id && view.label.accountId === accountId}
                onClick={() => onView({ ...view, mailbox: "all", label: { id: l.id, accountId } })}
                icon={
                  l.color ? (
                    <span className="size-2.5 rounded-full" style={{ backgroundColor: l.color }} />
                  ) : (
                    <Tag className="size-4 text-a11y-muted" />
                  )
                }
                label={l.name}
                badge={unread[l.id] ?? 0}
              />
            </ContextMenuTrigger>
            {(favorite || (unnest && l.name.includes("/"))) && (
              <ContextMenuContent>
                {favorite && (
                  <MenuItem icon={Star} onClick={() => favorite(l)}>
                    {favoriteMenuText(isFavorite(l), false)}
                  </MenuItem>
                )}
                {unnest && l.name.includes("/") && (
                  <MenuItem
                    icon={ArrowRight}
                    onClick={() => unnest(l)}
                  >{t`Move to top level`}</MenuItem>
                )}
              </ContextMenuContent>
            )}
          </ContextMenuRoot>
        ))}
      </Section>
    );
  });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="truncate px-2 pb-1 text-footnote font-semibold text-a11y-muted">{title}</h2>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

/** Initial on the account color, with the provider mark in the corner. */
function AccountAvatar({ account: a }: { account: Account }) {
  return (
    <span className="relative">
      <span
        className={`flex size-6 items-center justify-center rounded-full text-footnote font-semibold text-white ${accountColorClass(a)}`}
        style={accountColorStyle(a)}
      >
        {accountName(a).slice(0, 1).toUpperCase()}
      </span>
      <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-item bg-raised shadow-sm">
        <ProviderIcon provider={a.imap?.preset ?? a.provider} className="size-2.5" />
      </span>
    </span>
  );
}

function Tile(props: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  sublabel?: string;
  warn?: boolean;
  title: string;
  badge: number;
}) {
  const { i18n } = useLingui();
  return (
    <Tip label={props.title}>
      <button
        type="button"
        onClick={props.onClick}
        // One row in a narrow sidebar, a card in two columns once it has room.
        className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-card px-2 py-1.5 text-left [grid-template-areas:'icon_text_badge'] @min-[240px]/sidebar:grid-cols-[auto_minmax(0,1fr)] @min-[240px]/sidebar:gap-y-1.5 @min-[240px]/sidebar:px-2.5 @min-[240px]/sidebar:py-2 @min-[240px]/sidebar:[grid-template-areas:'icon_badge'_'text_text'] ${
          // Plain rows in one column; quiet cards once two columns make them tiles.
          props.active
            ? "bg-fill-pressed"
            : "hover:bg-fill-hover @min-[240px]/sidebar:bg-fill-quiet @min-[240px]/sidebar:hover:bg-fill-hover"
        }`}
      >
        <span className="flex [grid-area:icon]">{props.icon}</span>
        {props.badge > 0 && (
          <span className="justify-self-end text-footnote text-a11y-muted tabular-nums [grid-area:badge]">
            {i18n.number(props.badge)}
          </span>
        )}
        <span className="min-w-0 [grid-area:text]">
          <span className="block truncate text-body font-medium">{props.label}</span>
          {props.sublabel && (
            <span
              className={`block truncate text-caption ${props.warn ? "text-a11y-danger" : "text-a11y-muted"}`}
            >
              {props.sublabel}
            </span>
          )}
        </span>
      </button>
    </Tip>
  );
}

function Item(props: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge: number;
  indent?: boolean;
  disclosure?: ReactNode;
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement> | undefined;
}) {
  const { i18n } = useLingui();
  return (
    <div
      className={`group/item flex h-7 w-full items-center rounded-control pr-2 text-body ${
        props.active ? "bg-fill-pressed" : "hover:bg-fill-hover"
      }`}
    >
      <button
        type="button"
        {...props.buttonProps}
        onClick={props.onClick}
        aria-current={props.active ? "page" : undefined}
        className={`flex h-full min-w-0 flex-1 items-center gap-2.5 text-left ${
          props.indent ? "pl-8" : "pl-2"
        }`}
      >
        <span className="flex size-5 items-center justify-center">{props.icon}</span>
        <span className="min-w-0 flex-1 truncate" title={props.label}>
          {props.label}
        </span>
        {props.badge > 0 && (
          <span className="text-footnote text-a11y-muted tabular-nums">
            {i18n.number(props.badge)}
          </span>
        )}
      </button>
      {props.disclosure}
    </div>
  );
}

/** Opens a row's context menu from the keyboard: the Menu key or Shift+F10. */
function openMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom }),
  );
}

function useFavoriteMenuText() {
  const { t } = useLingui();
  return (on: boolean, allAccounts: boolean) =>
    on
      ? allAccounts
        ? t`Remove from favorites in all accounts`
        : t`Remove from favorites`
      : allAccounts
        ? t`Add to favorites in all accounts`
        : t`Add to favorites`;
}

/**
 * A row's favorite toggle. Out of the tab order: the row's context menu (Menu key or Shift+F10)
 * offers the same choice. The outline star shows while the pointer or focus is on the row.
 */
function FavoriteStar({
  name,
  pressed,
  allAccounts,
  onToggle,
}: {
  name: string;
  pressed: boolean;
  /** All accounts: the star covers the mailbox in every account of the space. */
  allAccounts: boolean;
  onToggle: () => void;
}) {
  const { t } = useLingui();
  const label = allAccounts ? t`Favorite ${name} in all accounts` : t`Favorite ${name}`;
  return (
    <Tip label={label}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onToggle}
        className={`px-1 text-amber-600 dark:text-amber-400 ${
          pressed
            ? ""
            : "opacity-0 group-focus-within/item:opacity-100 group-hover/item:opacity-100 focus-visible:opacity-100"
        }`}
      >
        {pressed ? "★" : "☆"}
      </button>
    </Tip>
  );
}
