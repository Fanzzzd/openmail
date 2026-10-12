import { Menu } from "@base-ui/react/menu";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AppWindow, ChevronRight } from "lucide-react";
import { useState } from "react";

import type { AttachmentApp } from "../../../../../shared/downloads";
import { causeText } from "../../../lib/errors";
import { useRunMail, withMail } from "../../../state/mail";
import { MenuItem } from "../../../ui/Menu";
import { itemClass, popupMotion, popupSurface } from "../../../ui/styles";

type Apps =
  | { kind: "loading" }
  | { kind: "ready"; apps: readonly AttachmentApp[] }
  | { kind: "error"; text: string };

/**
 * "Open With" inside an attachment's menu. The apps registered for the file
 * load when the submenu opens; picking one opens the attachment there.
 */
export function OpenWithSubmenu({
  messageId,
  path,
  onOpen,
}: {
  messageId: string;
  path: readonly number[];
  onOpen: (application: string) => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [apps, setApps] = useState<Apps>({ kind: "loading" });
  const load = () => {
    setApps({ kind: "loading" });
    run(
      withMail((call) => call("AttachmentApps", { messageId, path })).pipe(
        Effect.matchCause({
          onSuccess: (list) => setApps({ kind: "ready", apps: list }),
          onFailure: (cause) => setApps({ kind: "error", text: causeText(i18n, cause) }),
        }),
      ),
    );
  };
  return (
    <Menu.SubmenuRoot
      onOpenChange={(open) => {
        if (open) load();
      }}
    >
      <Menu.SubmenuTrigger
        className={`group ${itemClass} data-popup-open:not-data-highlighted:bg-fill-hover`}
      >
        <span className="flex size-4 shrink-0 items-center justify-center" />
        <span className="min-w-0 flex-1 truncate">{t`Open With`}</span>
        <ChevronRight aria-hidden className="ml-4 size-3.5 opacity-60" />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          render={<section aria-label={t`Open With`} />}
          className="z-[60] outline-none"
          alignOffset={-5}
          sideOffset={-2}
        >
          <Menu.Popup
            className={`max-h-[min(var(--available-height),320px)] min-w-48 overflow-y-auto p-[5px] ${popupSurface} ${popupMotion}`}
          >
            {apps.kind === "loading" && (
              <MenuItem disabled onClick={constVoid}>
                {t`Finding apps…`}
              </MenuItem>
            )}
            {apps.kind === "error" && (
              <MenuItem disabled onClick={constVoid}>
                {apps.text}
              </MenuItem>
            )}
            {apps.kind === "ready" && apps.apps.length === 0 && (
              <MenuItem disabled onClick={constVoid}>
                {t`No app can open this file`}
              </MenuItem>
            )}
            {apps.kind === "ready" &&
              apps.apps.map((app) => (
                <MenuItem
                  key={app.application}
                  icon={AppWindow}
                  onClick={() => onOpen(app.application)}
                >
                  {app.label}
                </MenuItem>
              ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}
