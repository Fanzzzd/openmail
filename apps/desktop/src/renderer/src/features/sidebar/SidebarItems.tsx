import { providerCapabilities } from "@openmail/core/schema";
import type { Account, Label } from "../../../../shared/api";
import type { View } from "../../lib/view";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { accountColorClass, accountColorStyle, accountName } from "../../lib/format";
import { ContextMenuContent, ContextMenuRoot, ContextMenuTrigger, MenuItem } from "../../ui/Menu";
import { ArrowRight, Star, Tag } from "lucide-react";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Tip } from "../../ui/Tip";

export function LabelSections({
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
        title={
          categories
            ? t`Outlook categories`
            : groups.size > 1
              ? email
              : account && providerCapabilities(account.provider).organization === "folders"
                ? t`Folders`
                : t`Labels`
        }
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
              <ContextMenuContent label={t`Folder actions`}>
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

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="truncate px-2 pb-1 text-footnote font-semibold text-a11y-muted">{title}</h2>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

/** Initial on the account color, with the provider mark in the corner. */
export function AccountAvatar({ account: a }: { account: Account }) {
  return (
    <span className="relative">
      {/* The initial repeats the account name next to it, so screen readers skip it. */}
      <span
        aria-hidden
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

export function Tile(props: {
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
        aria-current={props.active ? "page" : undefined}
        // One row in a narrow sidebar, a card in two columns once it has room.
        className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-card px-2 py-1.5 text-left [grid-template-areas:'icon_text_badge'] @min-[240px]/sidebar:grid-cols-[auto_minmax(0,1fr)] @min-[240px]/sidebar:gap-y-1.5 @min-[240px]/sidebar:px-2.5 @min-[240px]/sidebar:py-2 @min-[240px]/sidebar:[grid-template-areas:'icon_badge'_'text_text'] ${
          // Plain rows in one column; quiet cards once two columns make them tiles.
          props.active
            ? "bg-fill-pressed"
            : "hover:bg-fill-hover @min-[240px]/sidebar:bg-fill-quiet @min-[240px]/sidebar:hover:bg-fill-hover"
        }`}
      >
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
        {/* The icon (the provider mark) and the count follow the name in the DOM, so a screen
            reader hears "Work, work.example, Gmail, 4"; the grid areas still draw them in place. */}
        <span className="flex [grid-area:icon]">{props.icon}</span>
        {props.badge > 0 && (
          <span className="justify-self-end text-footnote text-a11y-muted tabular-nums [grid-area:badge]">
            {i18n.number(props.badge)}
          </span>
        )}
      </button>
    </Tip>
  );
}

export function Item(props: {
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
  // Every row ends with its count at the same edge as the account rows above. The row's own
  // controls (favorite star, Inbox categories, reorder arrows) take that end while the pointer or
  // focus is on the row, in place of the count, so they never push counts into other columns.
  return (
    <div
      className={`group/item relative flex h-7 w-full items-center rounded-control pr-2 text-body ${
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
          <span
            data-sidebar-count
            className={`text-footnote text-a11y-muted tabular-nums ${
              props.disclosure ? "group-focus-within/item:invisible group-hover/item:invisible" : ""
            }`}
          >
            {i18n.number(props.badge)}
          </span>
        )}
      </button>
      {props.disclosure && (
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100 group-hover/item:pointer-events-auto group-hover/item:opacity-100">
          {props.disclosure}
        </span>
      )}
    </div>
  );
}

/** Opens a row's context menu from the keyboard: the Menu key or Shift+F10. */
export function openMenuFromKeyboard(event: React.KeyboardEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left, clientY: rect.bottom }),
  );
}

export function useFavoriteMenuText() {
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
 * offers the same choice. It shows, filled or outlined, while the pointer or focus is on the row.
 */
export function FavoriteStar({
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
        className="px-1 text-amber-800 dark:text-amber-400"
      >
        {pressed ? "★" : "☆"}
      </button>
    </Tip>
  );
}
