import type { Prefs } from "@openmail/core/schema";
import { useEffect, type RefObject } from "react";
import { matchesShortcut } from "../../../shared/shortcuts";
import { confirmOpen } from "../components/ui/Confirm";
import { type Draft } from "../draft";
import type { useComposeEditor } from "./use-compose-editor";
import type { useComposeRecipients } from "./use-compose-recipients";
import type { useComposeSend } from "./use-compose-send";
import type { useDraftLifecycle } from "./use-draft-lifecycle";

export function useComposeShortcuts({
  draft,
  prefs,
  recipients,
  sendFlow,
  editor,
  lifecycle,
  ccRef,
}: {
  draft: Draft;
  prefs: Prefs;
  recipients: ReturnType<typeof useComposeRecipients>;
  sendFlow: ReturnType<typeof useComposeSend>;
  editor: ReturnType<typeof useComposeEditor>;
  lifecycle: ReturnType<typeof useDraftLifecycle>;
  ccRef: RefObject<HTMLInputElement | null>;
}) {
  const { asking, submit } = sendFlow;
  const { closing, checkingClose, saveNow, close } = lifecycle;
  const { templateForm, fileRef, setPicker } = editor;
  const { setShowBcc } = recipients;
  useEffect(() => {
    // Bubble phase: fields that handle a key themselves (suggestions) mark it handled first.
    // Escape belongs to the dialog: it closes the innermost popup, then the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || asking || closing || checkingClose || templateForm || confirmOpen())
        return;
      if (matchesShortcut(prefs.shortcutSet, "sendArchive", e)) {
        e.preventDefault();
        submit(true);
      } else if (matchesShortcut(prefs.shortcutSet, "send", e)) {
        e.preventDefault();
        submit(false);
      } else if (matchesShortcut(prefs.shortcutSet, "attach", e)) {
        e.preventDefault();
        fileRef.current?.click();
      } else if (matchesShortcut(prefs.shortcutSet, "saveDraft", e)) {
        e.preventDefault();
        saveNow(draft);
      } else if (matchesShortcut(prefs.shortcutSet, "closeCompose", e) && e.key !== "Escape") {
        e.preventDefault();
        close();
      } else if (matchesShortcut(prefs.shortcutSet, "showCc", e)) {
        e.preventDefault();
        setShowBcc(true);
        requestAnimationFrame(() => ccRef.current?.focus());
      } else if (matchesShortcut(prefs.shortcutSet, "templates", e)) {
        e.preventDefault();
        setPicker((v) => !v);
      }
    };
    const attach = () => fileRef.current?.click();
    window.addEventListener("openmail-attach-files", attach);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("openmail-attach-files", attach);
    };
  });
}
