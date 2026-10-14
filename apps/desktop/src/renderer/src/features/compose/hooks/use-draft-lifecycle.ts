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
  type RefObject,
  type SetStateAction,
} from "react";
import type { OutgoingAttachment } from "../../../../../shared/api";
import type { ComposeMessages } from "./use-compose-messages";
import { draftSyncNotice } from "../components/DraftSyncRecovery";
import { loadOriginalAttachments, withOriginalAttachments } from "../compose-originals";
import { fromStored, toDraftInput, type Draft } from "../draft";
import { requestDraftClose } from "../draft-close";
import { causeText, draftConflict } from "../../../lib/errors";
import { draftStatus, openDraft, saveDraft, useRunMail, withMail } from "../../../state/mail";
import { saveDraftAtom } from "../../../state/mutations";
import { draftStatusAtom } from "../../../state/queries";
import { onBackup, onFlush, setUnsaved } from "../../../state/unsaved-work";
import { clearDraftBackup, wasRestored, writeDraftBackup } from "../draft-backup";
import { useWebConnection } from "../../../state/web-connection";

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
  handedOff,
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
  /** The draft as send, discard, close or pop out took it; later edits make it stale. */
  handedOff: RefObject<Draft | null>;
}) {
  const { i18n } = useLingui();
  // A draft reopened from the tab's backup has typing the Mac may lack: it saves at once.
  const saved = useRef<Draft | null>(wasRestored(initial.id) ? null : initial);
  /** Whether the Mac has had this draft: opened from storage, or saved since. */
  const known = useRef(initial.synced !== undefined);

  const [closing, setClosing] = useState(false);
  const [checkingClose, setCheckingClose] = useState(false);

  const [saveState, save] = useAtom(saveDraftAtom(initial.id));
  useEffect(() => {
    if (saveState._tag === "Success") known.current = true;
  }, [saveState]);

  const saveNow = (next: Draft = draft) => {
    saved.current = next;
    save(toDraftInput(next));
  };

  /**
   * Someone else saved this draft after this editor loaded it, so core refused our save.
   * The editor shows the newer version and keeps the person's own text one click away.
   */
  const [conflict, setConflict] = useState<Draft | null>(null);
  const conflictRevision = draftConflict(saveState);
  const reloadNewer = useEffectEvent(() => {
    const mine = draft;
    run(
      openDraft(draft.id).pipe(
        Effect.matchCause({
          onSuccess: (stored) => {
            const newer = fromStored(stored);
            saved.current = newer;
            setDraft(newer);
            setConflict(mine);
          },
          onFailure: (cause) => setError(causeText(i18n, cause)),
        }),
      ),
    );
  });
  useEffect(() => {
    if (conflictRevision !== null) reloadNewer();
  }, [conflictRevision]);
  /** Puts the person's own text back; the next save replaces the newer version on purpose. */
  const restoreMine = () => {
    if (!conflict) return;
    setDraft({ ...conflict, revision: draft.revision ?? 0 });
    setConflict(null);
  };
  const saveFailed = saveState._tag === "Failure" && conflictRevision === null;

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

  /**
   * Saves typing the autosave has not reached yet. Runs when the composer unmounts without
   * handing the draft off (another draft replaced it), when the page hides, and before quit.
   */
  const flush = useEffectEvent(() => {
    if (empty || adding || recovering || handedOff.current === draft || draft === saved.current)
      return Effect.void;
    saved.current = draft;
    return saveDraft(toDraftInput(draft)).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => setUnsaved(initial.id, false))),
    );
  });
  useEffect(() => {
    const unregister = onFlush(
      () =>
        new Promise<void>((resolve) => {
          run(flush().pipe(Effect.ensuring(Effect.sync(resolve))));
        }),
    );
    return () => {
      unregister();
      run(flush());
    };
  }, [run]);
  // The web build waits to reload while typing is unsaved.
  useEffect(() => {
    const unsaved = (draft !== saved.current && !empty) || saveState.waiting || saveFailed;
    setUnsaved(initial.id, unsaved);
    // Saved: the Mac's copy is current, so the tab's backup goes.
    if (!unsaved) clearDraftBackup(initial.id);
  }, [initial.id, draft, empty, saveState, saveFailed]);
  // Closing, sending or discarding unmounts the composer: no backup outlives it.
  useEffect(
    () => () => {
      setUnsaved(initial.id, false);
      clearDraftBackup(initial.id);
    },
    [initial.id],
  );
  const backup = useEffectEvent(() => {
    if (empty || handedOff.current === draft) return;
    const unsaved = draft !== saved.current || saveState.waiting || saveFailed;
    if (unsaved) writeDraftBackup(draft, known.current);
  });
  useEffect(() => onBackup(backup), []);
  // A save the dropped connection failed goes again once the Mac is back.
  const connection = useWebConnection();
  const retrySave = useEffectEvent(() => {
    if (saveFailed && !saveState.waiting) saveNow();
  });
  useEffect(() => {
    if (connection === "open") retrySave();
  }, [connection]);

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
      requestDraftClose({ draft, initial, empty, lookup: draftStatus(draft.id) }).pipe(
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

  // The counters outlive one composer: the main window keeps them across inline drafts. Only a
  // request made while this composer is open acts on it, never one left from an earlier draft.
  const requestsAtOpen = useRef({ popOut: popOutRequested, close: closeRequested });
  const nativePopOut = useEffectEvent(() => onPopOut?.(draft));
  useEffect(() => {
    if (popOutRequested > requestsAtOpen.current.popOut) queueMicrotask(() => nativePopOut());
  }, [popOutRequested]);
  const nativeClose = useEffectEvent(close);
  useEffect(() => {
    if (closeRequested > requestsAtOpen.current.close) queueMicrotask(() => nativeClose());
  }, [closeRequested]);

  const status =
    recovering || saveState.waiting
      ? messages.saving
      : saveFailed
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
    conflict,
    restoreMine,
    dismissConflict: () => setConflict(null),
  };
}
