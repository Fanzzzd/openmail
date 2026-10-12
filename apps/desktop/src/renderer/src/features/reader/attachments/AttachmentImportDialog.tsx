import { constVoid } from "effect/Function";
import { useEffect, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Effect } from "effect";
import {
  EMPTY_QUOTE_HISTORY,
  formatCalendarTime,
  type AttachmentInspection,
  type ReaderAttachment,
} from "@openmail/core/schema";
import { useRunMail, withMail } from "../../../state/mail";
import { Dialog } from "../../../ui/Dialog";
import { LazyEmailFrame } from "../body/MessageBodyShell";

/** Review imported data inside the app. Files never launch an OS handler. */
export function AttachmentImportDialog({
  messageId,
  file,
  onClose,
}: {
  messageId: string;
  file: ReaderAttachment;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const run = useRunMail();
  const [inspection, setInspection] = useState<AttachmentInspection | null>(null);
  const [failed, setFailed] = useState(false);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let active = true;
    run(
      withMail((call) => call("InspectAttachment", { messageId, path: file.path })).pipe(
        Effect.match({
          onSuccess: (value) => {
            if (active) setInspection(value);
          },
          onFailure: () => {
            if (active) setFailed(true);
          },
        }),
      ),
    );
    return () => {
      active = false;
    };
  }, [messageId, file.path, run]);
  const perform = (
    key: string,
    effect: Effect.Effect<
      void,
      import("../../../lib/errors").AppError,
      import("../../../state/mail").MailEnv
    >,
  ) => {
    setAdded((current) => new Set([...current, key]));
    run(
      effect.pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            setFailed(true);
            setAdded((current) => new Set([...current].filter((k) => k !== key)));
          }),
        ),
      ),
    );
  };
  return (
    <Dialog
      aria-label={file.filename}
      onClose={onClose}
      className="w-[min(90vw,760px)] space-y-4 overflow-auto p-5"
    >
      <h2 className="font-semibold">{file.filename}</h2>
      {failed && <p role="alert">{t`Could not import this attachment.`}</p>}
      {!inspection && !failed && <p>{t`Loading…`}</p>}
      {inspection?.kind === "html" && (
        <LazyEmailFrame
          html={inspection.html}
          remote={false}
          background="light"
          zoom={100}
          onActivate={constVoid}
          previous={EMPTY_QUOTE_HISTORY}
          findQuery=""
          findIndex={0}
          onMatches={undefined}
        />
      )}
      {inspection?.kind === "contacts" && (
        <>
          <p>{t`Review the contacts before adding them.`}</p>
          {inspection.contacts.map((contact) => (
            <div key={contact.address} className="flex items-center justify-between gap-4">
              <p className="break-all">
                {contact.name} &lt;{contact.address}&gt;
              </p>
              <button
                type="button"
                disabled={added.has(contact.address)}
                onClick={() =>
                  perform(
                    contact.address,
                    withMail((call) => call("AddAppleContact", { contact })),
                  )
                }
              >{t`Add to Contacts`}</button>
            </div>
          ))}
        </>
      )}
      {inspection?.kind === "calendar" && (
        <>
          <p>{t`Review the events before adding them.`}</p>
          {inspection.invites.map((invite) => (
            <div key={invite.key} className="space-y-2">
              <p>{invite.title}</p>
              {invite.start && (
                <p>
                  {formatCalendarTime(invite.start, i18n.locale)}
                  {invite.end && ` – ${formatCalendarTime(invite.end, i18n.locale)}`}
                </p>
              )}
              <p>{invite.location}</p>
              {invite.organizer && (
                <p>
                  {invite.organizer.name} &lt;{invite.organizer.address}&gt;
                </p>
              )}
              {invite.method === "PUBLISH" && (
                <button
                  type="button"
                  disabled={added.has(invite.key)}
                  onClick={() =>
                    perform(
                      invite.key,
                      withMail((call) =>
                        call("ImportCalendarAttachment", {
                          messageId,
                          path: file.path,
                          key: invite.key,
                        }),
                      ),
                    )
                  }
                >{t`Add to calendar`}</button>
              )}
              {invite.method !== "PUBLISH" && (
                <p>{t`Respond to this invitation from the message.`}</p>
              )}
            </div>
          ))}
        </>
      )}
      <button type="button" onClick={onClose}>{t`Close`}</button>
    </Dialog>
  );
}
