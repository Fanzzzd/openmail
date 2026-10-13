import {
  MAILBOX_NAMES,
  categoryAccounts,
  inboxCategoryNames,
  scopeAccountIds,
  spaceAccounts,
  type SpaceId,
  type View,
} from "../../lib/view";
import type { Account, Label, Profile, SyncProgress, SyncState } from "../../../../shared/api";
import { useState, type ButtonHTMLAttributes } from "react";
import { withMail } from "../../state/mail";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { labelPreferencesAtom, labelsAtom, organizationAtom, prefsAtom } from "../../state/queries";
import { Trans, useLingui } from "@lingui/react/macro";
import { useShortcutText } from "../../i18n/use-shortcut-text";
import {
  AccountAvatar,
  FavoriteStar,
  Item,
  LabelSections,
  Section,
  Tile,
  openMenuFromKeyboard,
  useFavoriteMenuText,
} from "./SidebarItems";
import { CATEGORY_ICONS, MAILBOXES, useMailboxCounts } from "./sidebar-mailboxes";
import { accountColorValue, accountName } from "../../lib/format";
import { favoriteView } from "./favorite-navigation";
import { Effect } from "effect";
import { DEFAULT_PREFS, specialFolderBadge } from "@openmail/core/schema";
import {
  DragLabel,
  DragMessages,
  FAVORITE_DRAG,
  LABEL_DRAG,
  MESSAGE_DRAG,
  decodeDrag,
} from "../organize";
import { SidebarAccountIssues, syncFailures } from "../sync-status";
import { iconButton, titlebarRow } from "../../ui/styles";
import { TrafficLightSpace } from "../../ui/TrafficLights";
import { isDesktop } from "../../lib/platform";
import { Tip } from "../../ui/Tip";
import {
  ChevronDown,
  ChevronRight,
  Layers,
  PanelLeft,
  Pencil,
  Plus,
  Sparkles,
  SquarePen,
  Star,
  Tag,
} from "lucide-react";
import { ContextMenuContent, ContextMenuRoot, ContextMenuTrigger, MenuItem } from "../../ui/Menu";
import { SpaceSwitcher } from "./SpaceSwitcher";
import { SidebarFooter } from "./SidebarFooter";
import { useSidebarOrganize } from "./use-sidebar-organize";

interface Props {
  /** A complementary landmark, unless it sits inside the main landmark of the docked layout. */
  landmark?: boolean;
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
  landmark = true,
}: Props) {
  const [categoriesOpen, setCategoriesOpen] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => null);
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
  const {
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
  } = useSidebarOrganize({ view, accounts, members, scope, labelPrefs, favoriteLabels });
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

  // Inside the layout's main landmark a labelled section keeps the footer from reading as contentinfo.
  const Landmark = landmark ? "aside" : "section";
  return (
    <Landmark
      aria-label={landmark ? undefined : t`Sidebar`}
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

      <SidebarFooter
        accounts={accounts}
        syncState={syncState}
        progress={progress}
        failures={failures}
        onSettings={onSettings}
      />

      <SpaceSwitcher
        space={view.space}
        profiles={profiles}
        onSpace={onSpace}
        onEditProfile={onEditProfile}
      />
    </Landmark>
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
