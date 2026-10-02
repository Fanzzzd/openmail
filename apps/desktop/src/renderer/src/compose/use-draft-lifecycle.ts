import { useAtom, useAtomValue } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import { constVoid } from "effect/Function";
import { AsyncResult } from "effect/reactivity";
import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { OutgoingAttachment } from "../../../shared/api";
import type { ComposeMessages } from "../components/Composer";
import { draftSyncNotice } from "../components/DraftSyncRecovery";
import { loadOriginalAttachments, withOriginalAttachments } from "../compose-originals";
import { toDraftInput, type Draft } from "../draft";
import { requestDraftClose } from "../draft-close";
import { causeText } from "../errors";
import { openDraft, useRunMail, withMail } from "../state/mail";
import { saveDraftAtom } from "../state/mutations";
import { draftStatusAtom } from "../state/queries";

const AUTOSAVE_MS = 2000;
export function useDraftLifecycle({
  initial,
  draft,
  run,
  adding,
  empty,
  setDraft,
  setAdding,
  setError,
  onClose,
  onPopOut,
  popOutRequested,
  closeRequested,
  messages,
}: {
  messages: ComposeMessages;
  initial: Draft;
  draft: Draft;
  run: ReturnType<typeof useRunMail>;
  adding: boolean;
  empty: boolean;
  setDraft: Dispatch<SetStateAction<Draft>>;
  setAdding: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string | null>>;
  onClose: (draft: Draft, changed: boolean) => void;
  onPopOut: ((draft: Draft) => void) | undefined;
  popOutRequested: number;
  closeRequested: number;
}) {
  const { i18n } = useLingui();
  const saved = useRef(initial);

  const [closing, setClosing] = useState(false);
  const [checkingClose, setCheckingClose] = useState(false);

  const [saveState, save] = useAtom(saveDraftAtom(initial.id));

  const saveNow = (next: Draft = draft) => {
    saved.current = next;
    save(toDraftInput(next));
  };

  const remoteStatus = AsyncResult.getOrElse(useAtomValue(draftStatusAtom(draft.id)), () => null);
  const syncStatus = remoteStatus ?? (saveState._tag === "Success" ? saveState.value : null);
  const syncNotice = draftSyncNotice(syncStatus ?? initial);
  const [recoveryError, setRecoveryError] = useState("");
  const [recovering, setRecovering] = useState(false);
  const recover = (action: "retry" | "local") => {
    if (recovering) return;
    setRecovering(true);
    run(
      withMail((call) =>
        call("RecoverDraft", { id: draft.id, action, draft: toDraftInput(draft) }),
      ).pipe(
        Effect.matchCause({
          onSuccess: () => {
            saved.current = draft;
            setRecovering(false);
            setRecoveryError("");
          },
          onFailure: (cause) => {
            setRecovering(false);
            setRecoveryError(causeText(i18n, cause));
          },
        }),
      ),
    );
  };

  // Autosave: locally at once, then to the provider through the queue.
  useEffect(() => {
    const due =
      !recovering && !adding && !closing && !checkingClose && draft !== saved.current && !empty;
    const timer = due
      ? setTimeout(() => {
          saved.current = draft;
          save(toDraftInput(draft));
        }, AUTOSAVE_MS)
      : undefined;
    return () => clearTimeout(timer);
  }, [draft, save, closing, checkingClose, empty, adding, recovering]);

  const originalsLoaded = useEffectEvent((files: readonly OutgoingAttachment[]) => {
    setDraft((current) => withOriginalAttachments(current, files));
    setAdding(false);
  });
  const originalsFailed = useEffectEvent((reason: string) => {
    setDraft((current) => ({
      ...current,
      loadOriginalAttachments: false,
      includeOriginalAttachments: false,
    }));
    setAdding(false);
    setError(messages.couldntLoadTheOriginalAttachments(reason));
  });
  useEffect(() => {
    const id = initial.inReplyTo;
    if (!initial.loadOriginalAttachments || !id) return constVoid;
    let active = true;
    run(
      loadOriginalAttachments(
        withMail((call) => call("ComposeAttachments", { id })),
        (files) => {
          if (active) originalsLoaded(files);
        },
        (cause) => {
          if (active) originalsFailed(causeText(i18n, cause));
        },
      ),
    );
    return () => {
      active = false;
    };
  }, [initial, run, i18n]);

  const close = () => {
    if (closing || checkingClose || saveState.waiting) return;
    setCheckingClose(true);
    run(
      requestDraftClose({ draft, initial, empty, lookup: openDraft(draft.id) }).pipe(
        Effect.matchCause({
          onSuccess: (action) => {
            setCheckingClose(false);
            if (action === "prompt") setClosing(true);
            else onClose(draft, false);
          },
          onFailure: () => {
            setCheckingClose(false);
            setClosing(true);
          },
        }),
      ),
    );
  };

  const nativePopOut = useEffectEvent(() => onPopOut?.(draft));
  useEffect(() => {
    if (popOutRequested > 0) queueMicrotask(() => nativePopOut());
  }, [popOutRequested]);
  const nativeClose = useEffectEvent(close);
  useEffect(() => {
    if (closeRequested > 0) queueMicrotask(() => nativeClose());
  }, [closeRequested]);

  const status =
    recovering || saveState.waiting
      ? messages.saving
      : saveState._tag === "Failure"
        ? messages.couldntSave
        : syncNotice === "local"
          ? messages.keptOnThisMac
          : syncNotice === "failed"
            ? messages.couldntSync
            : syncNotice === "retrying"
              ? messages.savedOnThisMacRetryingSyncAutomatically
              : (syncStatus?.synced ?? initial.synced)
                ? messages.saved
                : saveState._tag === "Success" || syncStatus
                  ? messages.savedOnThisMacSyncsWhenOnline
                  : "";

  return {
    saveState,
    saveNow,
    closing,
    setClosing,
    checkingClose,
    recover,
    recovering,
    recoveryError,
    syncStatus,
    syncNotice,
    close,
    status,
  };
}
