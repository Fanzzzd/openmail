import { linkHint, linkIdentity } from "@openmail/core/schema";
import { useLingui } from "@lingui/react/macro";
import { useRef } from "react";
import { Dialog } from "../../../ui/Dialog";

export function LinkConfirmDialog({
  url,
  onClose,
  onOpen,
  returnFocus,
}: {
  url: string;
  onClose: () => void;
  onOpen: (url: string) => void;
  returnFocus: () => HTMLElement | null;
}) {
  const { t } = useLingui();
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      aria-label={t`Open this link?`}
      onClose={onClose}
      initialFocus={cancel}
      finalFocus={returnFocus}
      className="w-[min(90vw,480px)] space-y-4 p-5"
    >
      <p>{t`The displayed link may hide its destination. Check the real domain before opening.`}</p>
      <p className="font-mono break-all">{linkIdentity(url)?.domain}</p>
      <p className="font-mono break-all">{linkHint(url)}</p>
      <div className="flex justify-end gap-4">
        <button ref={cancel} type="button" onClick={onClose}>{t`Cancel`}</button>
        <button
          type="button"
          onClick={() => {
            onOpen(url);
            onClose();
          }}
        >{t`Open link`}</button>
      </div>
    </Dialog>
  );
}
