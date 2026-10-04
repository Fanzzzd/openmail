import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  calendarEventIcs,
  DEFAULT_PREFS,
  formatCalendarRange,
  type CalendarEvent,
} from "@openmail/core/schema";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Message } from "../../../shared/api";
import { calendarEventsAtom, detectedEventsAtom, prefsAtom, accountsAtom } from "../state/queries";
import { createCalendarEventAtom, reauthAtom } from "../state/mutations";
import { Keys } from "../state/keys";
import { type AppError, resultError } from "../errors";
import { Dialog, alertButton, alertPrimary } from "./ui/Dialog";
import { formButton } from "./ui/form-styles";

/** The failure of a calendar call, for CalendarAccessAction. */
export function calendarFailure<A>(result: AsyncResult.AsyncResult<A, AppError>) {
  if (result._tag !== "Failure") return null;
  const error = Cause.findErrorOption(result.cause);
  return error._tag === "Some" ? error.value : null;
}

/**
 * The fix for a failed calendar call: a provider 403 asks for calendar consent,
 * a rejected sign-in (401, invalid_grant) asks to sign in again.
 */
export function CalendarAccessAction({
  accountId,
  error,
}: {
  accountId: string;
  error: AppError | null;
}) {
  const { i18n } = useLingui();
  const [authorization, authorize] = useAtom(reauthAtom(accountId), { mode: "promiseExit" });
  if (error?._tag !== "FeatureScopeMissing" && error?._tag !== "AuthError") return null;
  const signIn = error._tag === "AuthError";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        className={formButton}
        disabled={authorization.waiting}
        onClick={() => authorize(signIn ? undefined : "calendar")}
      >
        {signIn ? <Trans>Sign in again</Trans> : <Trans>Connect Calendar</Trans>}
      </button>
      {resultError(i18n, authorization) && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          {resultError(i18n, authorization)}
        </p>
      )}
    </div>
  );
}

export function OverlappingEvents({
  accountId,
  messageId,
  inviteKey,
}: {
  accountId: string;
  messageId: string;
  inviteKey: string;
}) {
  const { i18n } = useLingui();
  const result = useAtomValue(calendarEventsAtom(messageId, inviteKey));
  const events = AsyncResult.getOrElse(result, () => []);
  const failure = calendarFailure(result);
  return (
    <section className="space-y-1 border-t border-blue-200 pt-2 dark:border-blue-900">
      <h4 className="font-semibold">
        <Trans>Your overlapping events</Trans>
      </h4>
      {result.waiting ? (
        <p>
          <Trans>Loading calendar…</Trans>
        </p>
      ) : result._tag === "Failure" ? (
        <div className="space-y-1">
          <p role="alert">
            {failure?._tag === "FeatureScopeMissing" ? (
              resultError(i18n, result)
            ) : (
              <>
                <Trans>Could not load your calendar.</Trans> {resultError(i18n, result)}
              </>
            )}
          </p>
          <CalendarAccessAction accountId={accountId} error={failure} />
        </div>
      ) : events.length ? (
        <ul>
          {events.map((event) => (
            <li key={event.key}>
              {event.title} · {formatCalendarRange(event, i18n.locale)}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          <Trans>No overlapping events in your primary calendar.</Trans>
        </p>
      )}
    </section>
  );
}

export function DetectedCalendarEvents({ message }: { message: Message }) {
  const prefs = AsyncResult.getOrElse(useAtomValue(prefsAtom), () => DEFAULT_PREFS);
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const provider = accounts.find((a) => a.id === message.accountId)?.provider;
  if (!prefs.labs.calendarDetection || !provider) return null;
  return <LoadedEvents message={message} />;
}
function LoadedEvents({ message }: { message: Message }) {
  const result = useAtomValue(detectedEventsAtom(message.id));
  return (
    <>
      {AsyncResult.getOrElse(result, () => []).map((event) => (
        <EventConfirmation key={event.key} event={event} message={message} />
      ))}
    </>
  );
}
function EventConfirmation({ event, message }: { event: CalendarEvent; message: Message }) {
  const { t, i18n } = useLingui();
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState(false);
  const [result, create] = useAtom(createCalendarEventAtom, { mode: "promiseExit" });
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const provider = accounts.find((a) => a.id === message.accountId)?.provider;
  const email = accounts.find((a) => a.id === message.accountId)?.email ?? "";
  const range = formatCalendarRange(event, i18n.locale);
  return (
    <section className="mt-3 space-y-2 rounded-lg border border-blue-200 p-3 dark:border-blue-900">
      <h3 className="font-semibold">{event.title || message.subject}</h3>
      <p>
        {range}
        {event.start.kind === "date" && <> · {t`All day`}</>}
      </p>
      {event.endEstimated && (
        <p>
          <Trans>End time is estimated. Review it before adding the event.</Trans>
        </p>
      )}
      <button type="button" className={formButton} disabled={added} onClick={() => setOpen(true)}>
        {added ? t`Added to calendar` : t`Add to calendar`}
      </button>
      {open && (
        <Dialog
          aria-label={t`Add this event to your calendar?`}
          onClose={result.waiting ? undefined : () => setOpen(false)}
          className="w-[440px] max-w-[90vw] space-y-3 p-5"
        >
          <h2 className="font-semibold">{t`Add this event to your calendar?`}</h2>
          <p>{t`Review the event details before confirming.`}</p>
          <div className="max-h-64 space-y-2 overflow-auto break-words">
            <p>{email}</p>
            <h3 className="font-semibold">{event.title || message.subject}</h3>
            <p>{range}</p>
            {event.endEstimated && (
              <p>
                <Trans>End time is estimated. Review it before adding the event.</Trans>
              </p>
            )}
            {event.start.kind === "date" && (
              <p>
                <Trans>All day</Trans>
              </p>
            )}
            <p>
              {t`Location`}: {event.location || t`None`}
            </p>
            {event.description && <p className="whitespace-pre-wrap">{event.description}</p>}
            {!!event.recurrence.length && <p>{event.recurrence.join("; ")}</p>}
          </div>
          {resultError(i18n, result) && (
            <p role="alert" className="text-a11y-danger">
              {resultError(i18n, result)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className={alertButton}
              disabled={result.waiting}
              onClick={() => setOpen(false)}
            >
              <Trans>Cancel</Trans>
            </button>
            <button
              type="button"
              className={alertButton}
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([calendarEventIcs(event)], { type: "text/calendar;charset=utf-8" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = "event.ics";
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                setOpen(false);
              }}
            >{t`Download calendar file`}</button>
            {provider !== "imap" && (
              <button
                type="button"
                className={alertPrimary}
                disabled={result.waiting}
                onClick={async () => {
                  const exit = await create({
                    payload: { messageId: message.id, key: event.key },
                    reactivityKeys: [Keys.audit],
                  });
                  if (exit._tag === "Success") {
                    setAdded(true);
                    setOpen(false);
                  }
                }}
              >
                <Trans>Confirm and add event</Trans>
              </button>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
