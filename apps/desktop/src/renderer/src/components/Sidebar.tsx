import {
  SYSTEM_FOLDERS,
  systemFolderId,
  specialFolderBadge,
  DEFAULT_PREFS,
} from "@openmail/core/schema";
import { Effect } from "effect";
import {
  MESSAGE_DRAG,
  LABEL_DRAG,
  FAVORITE_DRAG,
  DragMessages,
  DragLabel,
  decodeDrag,
} from "../organize-drag";
import { MAIL_KEYS, Keys } from "../state/keys";
import { Toolbar } from "@base-ui/react/toolbar";
import { useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
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
import {
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
  useRef,
  useState,
} from "react";

import type {
  Account,
  Label,
  Mailbox,
  Profile,
  SyncProgress,
  SyncState,
} from "../../../shared/api";
import {
  accountName,
  accountColorClass,
  accountColorStyle,
  accountColorValue,
  PROFILE_BG,
} from "../format";
import { type MailEnv, withMail, syncNow, useRunMail } from "../state/mail";
import {
  prefsAtom,
  labelsAtom,
  labelPreferencesAtom,
  organizationAtom,
  unreadByLabelAtom,
} from "../state/queries";
import { useShortcutText } from "./SystemSettings";
import { ProviderIcon } from "./ProviderIcon";
import {
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "./ui/Menu";
import { Tip } from "./ui/Tip";
import {
  ALL,
  CATEGORY_NAMES,
  MAILBOX_NAMES,
  OVERVIEW,
  scopeAccountIds,
  type SpaceId,
  spaceAccounts,
  type View,
} from "../view";

type Icon = ComponentType<{ className?: string }>;

// Each mailbox gets its own icon color, as in Mimestream's sidebar.
const MAILBOXES: { id: Mailbox; icon: Icon; color: string }[] = [
  { id: "snoozed", icon: Clock, color: "text-violet-500" },
  { id: "inbox", icon: Inbox, color: "text-blue-500" },
  { id: "important", icon: Bookmark, color: "text-orange-500" },
  { id: "starred", icon: Star, color: "text-amber-500" },
  { id: "sent", icon: Send, color: "text-emerald-500" },
  { id: "drafts", icon: File, color: "text-sky-500" },
  { id: "spam", icon: ShieldAlert, color: "text-orange-600" },
  { id: "trash", icon: Trash2, color: "text-red-500" },
  { id: "all", icon: Mails, color: "text-violet-500" },
];

const CATEGORY_ICONS: Record<string, Icon> = {
  CATEGORY_PERSONAL: User,
  CATEGORY_SOCIAL: Users,
  CATEGORY_PROMOTIONS: Tag,
  CATEGORY_UPDATES: Info,
  CATEGORY_FORUMS: MessagesSquare,
};

const NO_COUNTS: Readonly<Record<string, number>> = {};

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
  const [organizeError, setOrganizeError] = useState("");
  const run = useRunMail();
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
  const [favoriteError, setFavoriteError] = useState<string | null>(null);
  const { t, i18n } = useLingui();
  const shortcut = useShortcutText();

  const members = spaceAccounts(view.space, accounts);
  const scope = scopeAccountIds({ ...view, label: undefined }, accounts);
  const byLabel = AsyncResult.getOrElse(
    useAtomValue(unreadByLabelAtom(scope, undefined, prefs?.threadGrouping !== false)),
    () => NO_COUNTS,
  );
  const inInbox = AsyncResult.getOrElse(
    useAtomValue(unreadByLabelAtom(scope, "INBOX", prefs?.threadGrouping !== false)),
    () => NO_COUNTS,
  );
  const labelPrefs = AsyncResult.getOrElse(useAtomValue(labelPreferencesAtom), () => []);
  const organization = AsyncResult.getOrElse(useAtomValue(organizationAtom), () => []);
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
  const labels = colored.filter(visible);
  const hidden = colored.filter((l) => !visible(l));
  const favorites = labelPrefs
    .filter(
      (p) =>
        p.favorite &&
        members.some((a) => a.id === p.accountId) &&
        (!scope || scope.includes(p.accountId)),
    )
    .flatMap<Label & { mailbox: Mailbox | null }>((p) => {
      const custom = colored.find((l) => l.accountId === p.accountId && l.id === p.id);
      const mailbox = SYSTEM_FOLDERS.find((id) => systemFolderId(id) === p.id);
      return custom
        ? [{ ...custom, mailbox: null }]
        : mailbox
          ? [
              {
                accountId: p.accountId,
                id: p.id,
                name: i18n._(MAILBOX_NAMES[mailbox]),
                color: null,
                mailbox,
              },
            ]
          : [];
    });
  const perform = <A, E>(effect: Effect.Effect<A, E, MailEnv>) =>
    run(
      effect.pipe(
        Reactivity.mutation(MAIL_KEYS),
        Effect.catchCause(() => Effect.sync(() => setOrganizeError(t`Action failed`))),
      ),
    );
  const toggleFavorite = (accountId: string, id: string) => {
    const pref = labelPrefs.find((p) => p.accountId === accountId && p.id === id) ?? {
      accountId,
      id,
      visible: true,
      favorite: false,
      color: null,
    };
    perform(
      withMail((call) =>
        call("SetLabelPreference", {
          input: {
            ...pref,
            favorite: !pref.favorite,
            position: favorites.length
              ? Math.max(...labelPrefs.map((p) => p.position ?? 0)) + 1
              : 0,
          },
        }),
      ),
    );
  };
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
      const mailbox = SYSTEM_FOLDERS.find((id) => systemFolderId(id) === target.id);
      if (mailbox && mailbox !== "inbox" && mailbox !== "trash" && mailbox !== "spam") return;
      const ids = messages.ids.filter((id) => id.startsWith(`${target.accountId}/`));
      if (ids.length)
        perform(
          withMail((call) =>
            call("ModifyWithUndo", {
              threads: ids,
              op: mailbox
                ? { kind: mailbox }
                : { kind: "move", labelId: target.id, removeLabelId: messages.removeLabelId },
              flat: messages.flat,
            }),
          ).pipe(Effect.asVoid),
        );
    }
  };
  const labelActions = (l: Label): ButtonHTMLAttributes<HTMLButtonElement> => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(LABEL_DRAG, JSON.stringify({ accountId: l.accountId, id: l.id }));
      e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e) => {
      if ([MESSAGE_DRAG, LABEL_DRAG].some((type) => e.dataTransfer.types.includes(type)))
        e.preventDefault();
    },
    onDrop: (e) => drop(e, l, true),
  });
  const profile = profiles.find((p) => p.id === view.space);
  const hasGmail = accounts.some(
    (a) =>
      a.enabled !== false &&
      a.provider === "gmail" &&
      (!scope || scope.includes(a.id)) &&
      organization.find((o) => o.accountId === a.id)?.categories !== false,
  );
  const spaceUnread = members.reduce((n, a) => n + (unread[a.id] ?? 0), 0);

  /** The footer line: progress while syncing, then failures or the last sync time. */
  const syncStatus = () => {
    if (syncState.running) {
      if (!progress) return t`Syncing…`;
      const { fetched, total } = progress;
      return t`Syncing ${fetched}/${total}`;
    }
    if (syncState.errors.length) {
      const count = syncState.errors.length;
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
    <aside className="flex h-full w-full flex-col bg-neutral-100/60 dark:bg-neutral-950/70">
      <div className="drag flex h-13 shrink-0 items-center justify-end gap-0.5 px-3">
        <Tip label={t`Add email account`}>
          <button
            type="button"
            aria-label={t`Add email account`}
            onClick={onAddAccount}
            className="rounded-md p-1 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10"
          >
            <Plus className="size-4.5" />
          </button>
        </Tip>
        <Tip label={t`New message`} shortcut={shortcut("compose")}>
          <button
            type="button"
            aria-label={t`New message`}
            onClick={onCompose}
            className="rounded-md p-1 text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10"
          >
            <SquarePen className="size-4.5" />
          </button>
        </Tip>
      </div>

      <div className="flex items-center gap-2 px-4.5 pb-3">
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          {profile ? `${profile.icon} ${profile.name}` : <Trans>All accounts</Trans>}
        </span>
        {profile && (
          <Tip label={t`Edit space`}>
            <button
              type="button"
              aria-label={t`Edit space`}
              onClick={() => onEditProfile(profile)}
              className="rounded p-1 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-3">
        {members.length > 1 && (
          <div className="mb-4 grid grid-cols-2 gap-1.5">
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
          <p className="px-2 pb-4 text-[12px] leading-relaxed text-neutral-500">
            {profile ? (
              <Trans>
                This space has no accounts yet.{" "}
                <button
                  type="button"
                  onClick={() => onEditProfile(profile)}
                  className="text-blue-600 dark:text-blue-400"
                >
                  Add account
                </button>
              </Trans>
            ) : (
              <Trans>This space has no accounts yet.</Trans>
            )}
          </p>
        )}
        {members
          .filter((a) => a.needsReauth)
          .map((a) => (
            <div
              key={a.id}
              className="mx-1 mb-3 rounded-lg bg-red-500/[0.08] px-3 py-2 text-[12px] leading-relaxed"
            >
              <p className="text-red-700 dark:text-red-300">
                <Trans>{a.email}'s sign-in has expired. Sync is paused.</Trans>
              </p>
              <button
                type="button"
                onClick={() => onReauth(a)}
                className="mt-1 font-semibold text-red-700 hover:underline dark:text-red-300"
              >
                <Trans>Sign in again</Trans>
              </button>
            </div>
          ))}

        {proposals > 0 && (
          <div className="mb-4">
            <Item
              active={false}
              onClick={onProposals}
              icon={<Sparkles className="size-4.5 text-violet-500" />}
              label={t`AI suggestions`}
              badge={proposals}
            />
          </div>
        )}

        <ContextMenuRoot>
          <ContextMenuTrigger render={<div />}>
            <Section title={t`Mailboxes`}>
              {MAILBOXES.map(({ id, icon: Icon, color }) => (
                <div key={id}>
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
                        if (messages && (id === "inbox" || id === "trash" || id === "spam"))
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
                        {members[0] && (
                          <button
                            type="button"
                            aria-label={t`Favorite`}
                            onClick={() => {
                              const accountId = view.accountId ?? members[0]?.id;
                              if (accountId) toggleFavorite(accountId, systemFolderId(id));
                            }}
                            className="px-1 text-amber-500"
                          >
                            {labelPrefs.some(
                              (p) =>
                                p.accountId === (view.accountId ?? members[0]?.id) &&
                                p.id === systemFolderId(id) &&
                                p.favorite,
                            )
                              ? "★"
                              : "☆"}
                          </button>
                        )}
                        {id === "inbox" && hasGmail ? (
                          <button
                            type="button"
                            aria-label={
                              categoriesOpen ? t`Collapse categories` : t`Expand categories`
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              setCategoriesOpen((v) => !v);
                            }}
                            className="-ml-1 rounded p-0.5 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
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
                  {id === "inbox" &&
                    hasGmail &&
                    categoriesOpen &&
                    Object.entries(CATEGORY_NAMES)
                      .filter(([category]) =>
                        accounts.some(
                          (a) =>
                            a.enabled !== false &&
                            a.provider === "gmail" &&
                            (!scope || scope.includes(a.id)) &&
                            organization.some(
                              (o) =>
                                o.accountId === a.id &&
                                o.categories &&
                                (o.selectedCategories === undefined ||
                                  o.selectedCategories.some((c) => c === category)),
                            ),
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
                            icon={<CatIcon className="size-4 text-blue-400" />}
                            label={i18n._(name)}
                            badge={inInbox[cat] ?? 0}
                          />
                        );
                      })}
                </div>
              ))}
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
                    onClick={() =>
                      onView(
                        l.mailbox
                          ? {
                              ...view,
                              accountId: l.accountId,
                              mailbox: l.mailbox,
                              label: undefined,
                            }
                          : {
                              ...view,
                              mailbox: "all",
                              label: { id: l.id, accountId: l.accountId },
                            },
                      )
                    }
                    icon={<Star className="size-4 text-amber-500" />}
                    label={l.name}
                    badge={0}
                  />
                ))}
              </Section>
            )}
          </ContextMenuTrigger>
          <ContextMenuContent>
            <MenuItem
              onClick={() =>
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
                )
              }
            >{t`Reset Favorites`}</MenuItem>
          </ContextMenuContent>
        </ContextMenuRoot>
        {favoriteError && <output className="px-3 text-xs text-red-600">{favoriteError}</output>}
        <LabelSections
          labels={labels}
          accounts={accounts}
          view={view}
          onView={onView}
          unread={byLabel}
          actions={labelActions}
          favorite={(l) => toggleFavorite(l.accountId, l.id)}
        />
        {hidden.length > 0 && (prefs?.showMore ?? true) && (
          <>
            <button
              type="button"
              aria-expanded={moreOpen}
              className="px-2 py-1 text-sm"
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
              />
            )}
          </>
        )}
        {organizeError && <p role="alert">{organizeError}</p>}
        {members.map((a) => (
          <button
            key={a.id}
            type="button"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(LABEL_DRAG)) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
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
            className="block px-2 py-1 text-xs text-neutral-500"
          >
            {t`No parent`} · {accountName(a)}
          </button>
        ))}
      </nav>

      <footer className="flex items-center gap-2 px-4 py-2 text-[12px] text-neutral-500">
        <span className="min-w-0 flex-1 truncate" title={syncState.errors.join("\n")}>
          {syncStatus()}
        </span>
        <Tip label={t`Settings`} shortcut={shortcut("settings")} side="top">
          <button
            type="button"
            aria-label={t`Settings`}
            onClick={onSettings}
            className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <SettingsIcon className="size-3.5" />
          </button>
        </Tip>
        <Tip label={t`Sync now`} shortcut={shortcut("sync")} side="top">
          <button
            type="button"
            aria-label={t`Sync now`}
            onClick={() => run(syncNow)}
            className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <RefreshCw className={`size-3.5 ${syncState.running ? "animate-spin" : ""}`} />
          </button>
        </Tip>
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

const ring = (active: boolean) =>
  active
    ? "bg-white shadow-sm ring-1 ring-black/10 dark:bg-white/15 dark:ring-white/10"
    : "hover:bg-black/5 dark:hover:bg-white/10";

const cell = (active: boolean) =>
  `flex size-8 shrink-0 items-center justify-center rounded-lg outline-offset-0 outline-blue-500/60 focus-visible:outline-[3px] ${ring(active)}`;

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
      className="flex items-center gap-1 overflow-x-auto border-t border-black/5 px-2.5 py-2 dark:border-white/5"
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
        <Toolbar.Separator className="mx-0.5 h-5 w-px shrink-0 bg-black/10 dark:bg-white/10" />
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
            <Tip
              key={p.id}
              label={p.name}
              shortcut={i < 9 ? `${shortcutSet === "gmail" ? "⌘" : "⌃⌘"}${i + 1}` : undefined}
              side="top"
            >
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
                  className={`flex size-6 items-center justify-center rounded-full text-[13px] ${PROFILE_BG[p.color]}`}
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
          className={`${cell(false)} text-neutral-400`}
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
}: {
  labels: readonly Label[];
  accounts: readonly Account[];
  view: View;
  onView: (v: View) => void;
  unread: Readonly<Record<string, number>>;
  actions?: (label: Label) => ButtonHTMLAttributes<HTMLButtonElement>;
  favorite?: (label: Label) => void;
}) {
  const { t } = useLingui();
  const groups = new Map<string, Label[]>();
  for (const l of labels) groups.set(l.accountId, [...(groups.get(l.accountId) ?? []), l]);
  return [...groups].map(([accountId, list]) => {
    const account = accounts.find((a) => a.id === accountId);
    const email = account ? accountName(account) : accountId;
    return (
      <Section key={accountId} title={groups.size > 1 ? email : t`Labels`}>
        {list.map((l) => (
          <Item
            key={l.id}
            buttonProps={actions?.(l)}
            disclosure={
              favorite && (
                <button
                  type="button"
                  aria-label={t`Favorite`}
                  className="text-amber-500"
                  onClick={() => favorite(l)}
                >
                  ☆
                </button>
              )
            }
            active={view.label?.id === l.id && view.label.accountId === accountId}
            onClick={() => onView({ ...view, mailbox: "all", label: { id: l.id, accountId } })}
            icon={
              l.color ? (
                <span className="size-2.5 rounded-full" style={{ backgroundColor: l.color }} />
              ) : (
                <Tag className="size-4 text-neutral-400" />
              )
            }
            label={l.name}
            badge={unread[l.id] ?? 0}
          />
        ))}
      </Section>
    );
  });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="truncate px-2 pb-1 text-[12px] font-semibold text-neutral-400 dark:text-neutral-500">
        {title}
      </h2>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

/** Initial on the account color, with the provider mark in the corner. */
function AccountAvatar({ account: a }: { account: Account }) {
  return (
    <span className="relative">
      <span
        className={`flex size-6 items-center justify-center rounded-full text-[12px] font-semibold text-white ${accountColorClass(a)}`}
        style={accountColorStyle(a)}
      >
        {accountName(a).slice(0, 1).toUpperCase()}
      </span>
      <span className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-[4px] bg-white shadow-sm dark:bg-neutral-800">
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
  return (
    <Tip label={props.title}>
      <button
        type="button"
        onClick={props.onClick}
        className={`flex min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left ${
          props.active
            ? "bg-black/[0.08] dark:bg-white/12"
            : "bg-black/[0.03] hover:bg-black/[0.05] dark:bg-white/[0.04] dark:hover:bg-white/[0.07]"
        }`}
      >
        <span className="flex items-center justify-between">
          {props.icon}
          {props.badge > 0 && (
            <span className="text-[12px] text-neutral-500 tabular-nums dark:text-neutral-400">
              {props.badge}
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium">{props.label}</span>
          {props.sublabel && (
            <span
              className={`block truncate text-[11px] ${props.warn ? "text-red-500" : "text-neutral-500 dark:text-neutral-400"}`}
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
  return (
    <div
      className={`flex h-8 w-full items-center rounded-md pr-2 text-[14px] ${
        props.active
          ? "bg-black/[0.07] dark:bg-white/10"
          : "hover:bg-black/[0.04] dark:hover:bg-white/5"
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
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.badge > 0 && (
          <span className="text-[12px] text-neutral-500 tabular-nums dark:text-neutral-400">
            {props.badge}
          </span>
        )}
      </button>
      {props.disclosure}
    </div>
  );
}
