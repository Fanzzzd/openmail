import { ALL, OVERVIEW, spaceShortcutLabel, type SpaceId } from "../../lib/view";
import { spaceItem } from "./sidebar-mailboxes";
import type { Profile } from "../../../../shared/api";
import { useLingui } from "@lingui/react/macro";
import { AsyncResult } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { prefsAtom } from "../../state/queries";
import { useRef, useState } from "react";
import { Toolbar } from "@base-ui/react/toolbar";
import { Tip } from "../../ui/Tip";
import { ArrowRight, Layers, LayoutGrid, Pencil, Plus } from "lucide-react";
import {
  ContextMenuContent,
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuSeparator,
} from "../../ui/Menu";
import { PROFILE_BG } from "../../lib/format";

const ring = (active: boolean) =>
  active ? "bg-white shadow-sm ring-1 ring-edge dark:bg-white/15" : "hover:bg-fill-hover";

const cell = (active: boolean) =>
  `flex size-8 shrink-0 items-center justify-center rounded-card outline-offset-0 outline-a11y-focus focus-visible:outline-[3px] ${ring(active)}`;

/** Arc-style row of spaces at the bottom of the sidebar. ⌃1 is the overview. */
export function SpaceSwitcher({
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
          data-focus-key={spaceItem(OVERVIEW)}
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
          data-focus-key={spaceItem(ALL)}
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
                data-focus-key={spaceItem(p.id)}
                aria-current={space === p.id || undefined}
                onClick={() => onSpace(p.id)}
                onContextMenu={() => {
                  pressed.current = p;
                }}
                className={cell(space === p.id)}
              >
                <span
                  className={`flex size-6 items-center justify-center rounded-full text-white text-body ${PROFILE_BG[p.color]}`}
                >
                  {p.icon}
                </span>
              </Toolbar.Button>
            </Tip>
          ))}
        </ContextMenuTrigger>
        {menuFor && (
          <ContextMenuContent label={t`Space`}>
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
