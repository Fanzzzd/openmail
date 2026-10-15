import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  calendarEventIcs,
  CalendarEventEdits,
  editCalendarEvent,
  calendarIanaZones,
  calendarZoneName,
  validateEventRecurrenceForProvider,
  type EventRecurrence,
  DEFAULT_PREFS,
  formatCalendarRange,
  calendarTimestamp,
  type CalendarEvent,
  providerCapabilities,
} from "@openmail/core/schema";
import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Cause, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";
import type { Message } from "../../../../shared/api";
import {
  calendarEventsAtom,
  detectedEventsAtom,
  prefsAtom,
  accountsAtom,
} from "../../state/queries";
import { createCalendarEventAtom, reauthAtom } from "../../state/mutations";
import { localTimeZone } from "../../lib/time-zone";
import { canCall } from "../../lib/platform";
import { SignInAgainOnMac } from "../../ui/SignInAgainOnMac";
import { Keys } from "../../state/keys";
import { type AppError, resultError, INPUT_ERRORS } from "../../lib/errors";
import { Dialog, alertButton, alertPrimary } from "../../ui/Dialog";
import { DropdownMenu, MenuItem } from "../../ui/Menu";
import { Select } from "../../ui/Select";
import { CalendarDays } from "lucide-react";
import { NO_VALUE } from "../../i18n/message-text";
import { EventRecurrenceEditor } from "./EventRecurrenceEditor";
import { formButton, formInput } from "../../ui/form-styles";

const DATE_ZONES = calendarIanaZones();
const DATE_ZONE_OPTIONS = DATE_ZONES.map((zone) => ({ value: zone, label: zone }));
function editorTimeZone(event: CalendarEvent): string {
  if (event.start.kind === "zoned") {
    try {
      const zone = calendarZoneName(event.start.zone);
      if (DATE_ZONES.includes(zone)) return zone;
    } catch {
      /* Unknown source zones remain visible in the event details. */
    }
  }
  return localTimeZone();
}
const CHECK_SETTINGS = msg`Check the date and repeat settings`;
function inputErrorText(error: unknown, i18n: I18n): string {
  const descriptor = error instanceof Error ? INPUT_ERRORS[error.message] : undefined;
  return i18n._(descriptor ?? CHECK_SETTINGS);
}
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
  if (!canCall("Reauth")) return <SignInAgainOnMac />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        className={formButton}
        disabled={authorization.waiting}
        onClick={() => authorize(signIn ? undefined : "calendar")}
      >
        {signIn ? <Trans>Sign in again</Trans> : <Trans>Connect calendar</Trans>}
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
                <Trans>Couldn't load your calendar.</Trans> {resultError(i18n, result)}
              </>
            )}
          </p>
          <CalendarAccessAction accountId={accountId} error={failure} />
        </div>
      ) : events.length ? (
        <ul>
          {events.map((event) => (
            <li key={event.key}>
              {event.title} · {formatCalendarRange(event, i18n.locale, localTimeZone())}
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
  const events = AsyncResult.getOrElse(useAtomValue(detectedEventsAtom(message.id)), () => []);
  // Only prose candidates carry the text they came from; structured events keep a card each.
  const prose = events.filter((event) => event.dateInput !== undefined);
  return (
    <>
      {events
        .filter((event) => event.dateInput === undefined)
        .map((event) => (
          <EventConfirmation key={event.key} event={event} message={message} />
        ))}
      {prose.length > 0 && <TextDates events={prose} message={message} />}
    </>
  );
}

/**
 * Dates found in the message text are guesses, so they share one quiet row
 * instead of a card each. Each menu entry opens the same confirmation dialog.
 */
function TextDates({ events, message }: { events: CalendarEvent[]; message: Message }) {
  const { t, i18n } = useLingui();
  const [opened, setOpened] = useState<string | null>(null);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="mt-2">
      <DropdownMenu
        label={t`Add to calendar`}
        align="start"
        trigger={
          <button
            type="button"
            className="-mx-2 inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-a11y-muted hover:bg-fill-hover"
          >
            <CalendarDays aria-hidden className="size-4 shrink-0" />
            {t({
              message: plural(events.length, { one: "# date found", other: "# dates found" }),
              context: "calendar dates",
              comment:
                "Dates detected in the message text. Opens a menu to add one of them to the calendar.",
            })}
          </button>
        }
      >
        {events.map((event) => (
          <MenuItem
            key={event.key}
            disabled={added.has(event.key)}
            onClick={() => setOpened(event.key)}
          >
            {Number.isFinite(calendarTimestamp(event.start, localTimeZone()))
              ? formatCalendarRange(event, i18n.locale, localTimeZone())
              : event.dateInput}
            {event.start.kind === "date" && <> · {t`All day`}</>}
            {added.has(event.key) && <> · {t`Added to calendar`}</>}
          </MenuItem>
        ))}
      </DropdownMenu>
      {events.map((event) => (
        <EventConfirmation
          key={event.key}
          event={event}
          message={message}
          dialogOnly={{
            open: opened === event.key,
            onClose: () => setOpened(null),
            onAdded: () => setAdded((keys) => new Set(keys).add(event.key)),
          }}
        />
      ))}
    </div>
  );
}

function EventConfirmation({
  event,
  message,
  dialogOnly,
}: {
  event: CalendarEvent;
  message: Message;
  /** Without a card: the caller opens the dialog and hears about the added event. */
  dialogOnly?: { open: boolean; onClose: () => void; onAdded: () => void };
}) {
  const { t, i18n } = useLingui();
  const location = event.location || i18n._(NO_VALUE);
  const [cardOpen, setCardOpen] = useState(false);
  const open = dialogOnly ? dialogOnly.open : cardOpen;
  const setOpen = (next: boolean) => {
    if (dialogOnly) {
      if (!next) dialogOnly.onClose();
    } else setCardOpen(next);
  };
  const [added, setAdded] = useState(false);
  const validationId = useId();
  const [dateInput, setDateInput] = useState<string | null>(event.dateInput ?? null);
  const [timeZone, setTimeZone] = useState(editorTimeZone(event));
  const zoneId = useId();
  const [recurrence, setRecurrence] = useState<EventRecurrence | null | undefined>(
    event.recurrence.length ? undefined : null,
  );
  const dates = dateInput === null ? undefined : { input: dateInput, timeZone };
  const edits: CalendarEventEdits = {
    ...(dates ? { dates } : {}),
    ...(recurrence === undefined ? {} : { recurrence }),
  };
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const account = accounts.find((a) => a.id === message.accountId);
  const provider = account?.provider;
  const email = account?.email ?? "";
  let preview: CalendarEvent | null = null;
  let datePreview: CalendarEvent | null = null;
  let validationError = "";
  let providerError = "";
  try {
    datePreview = editCalendarEvent(
      { ...event, recurrence: [] },
      dates ? { dates } : {},
      message.date,
      localTimeZone(),
    );
    preview = editCalendarEvent(
      event,
      Schema.decodeUnknownSync(CalendarEventEdits)(edits),
      message.date,
      localTimeZone(),
    );
    try {
      validateEventRecurrenceForProvider(preview, provider, localTimeZone());
    } catch (error) {
      providerError = inputErrorText(error, i18n);
    }
  } catch (error) {
    validationError = inputErrorText(error, i18n);
  }
  const [result, create] = useAtom(createCalendarEventAtom, { mode: "promiseExit" });
  const shown = preview ?? event;
  const range = preview
    ? formatCalendarRange(preview, i18n.locale, localTimeZone())
    : (event.dateInput ?? t`Choose a date and time`);
  const dialog = open && (
    <Dialog
      aria-label={t`Add this event to your calendar?`}
      onClose={result.waiting ? undefined : () => setOpen(false)}
      className="w-[440px] max-w-[90vw] space-y-3 p-5"
    >
      <h2 className="font-semibold">{t`Add this event to your calendar?`}</h2>
      <p>{t`Review the event details before confirming.`}</p>
      <div className="max-h-[55vh] space-y-2 overflow-auto break-words">
        <p>{email}</p>
        <h3 className="font-semibold">{event.title || message.subject}</h3>
        <p>{range}</p>
        {shown.endEstimated && (
          <p>
            <Trans>End time is estimated. Review it before adding the event.</Trans>
          </p>
        )}
        {shown.start.kind === "date" && (
          <p>
            <Trans>All day</Trans>
          </p>
        )}
        <p>{t`Location: ${location}`}</p>
        {event.description && <p className="whitespace-pre-wrap">{event.description}</p>}
        <label className="block">
          {t`Event date or range`}
          <input
            className={formInput}
            value={dateInput ?? ""}
            placeholder={t`For example: tomorrow 3pm or Oct 12–14`}
            disabled={result.waiting}
            // Only a date that does not parse marks the field; repeat errors belong to the editor.
            aria-invalid={datePreview ? undefined : true}
            aria-describedby={datePreview || !validationError ? undefined : validationId}
            onChange={(e) => setDateInput(e.target.value || null)}
          />
        </label>
        <p className="text-callout">{t`Relative dates use the date of this message.`}</p>
        <div className="space-y-1">
          <label htmlFor={zoneId} className="block">
            {t`Time zone`}
          </label>
          <Select
            id={zoneId}
            variant="field"
            aria-label={t`Time zone`}
            value={timeZone}
            disabled={result.waiting}
            options={DATE_ZONE_OPTIONS}
            onValueChange={(zone) => {
              setTimeZone(zone);
              if (dateInput === null) setDateInput(event.start.value);
            }}
          />
        </div>
        <EventRecurrenceEditor
          rule={recurrence}
          start={datePreview?.start ?? event.start}
          onChange={setRecurrence}
          disabled={result.waiting || !!event.hasRecurrenceOverrides || !datePreview}
        />
        {recurrence === undefined && !!event.recurrence.length && (
          <p>{event.recurrence.join("; ")}</p>
        )}
        {validationError && (
          <p id={validationId} role="alert" className="text-a11y-danger">
            {validationError}
          </p>
        )}
      </div>
      {providerError && (
        <p role="alert" className="text-a11y-danger">
          {providerError}
        </p>
      )}
      {resultError(i18n, result) && (
        <p role="alert" className="text-a11y-danger">
          {resultError(i18n, result)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
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
          disabled={result.waiting || !preview}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([calendarEventIcs(shown, localTimeZone())], {
                type: "text/calendar;charset=utf-8",
              }),
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "event.ics";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setOpen(false);
          }}
        >{t`Download calendar file`}</button>
        {(!provider || providerCapabilities(provider).calendar) && (
          <button
            type="button"
            className={alertPrimary}
            disabled={result.waiting || !preview || !!providerError}
            onClick={async () => {
              const exit = await create({
                payload: { messageId: message.id, key: event.key, edits },
                reactivityKeys: [Keys.audit],
              });
              if (exit._tag === "Success") {
                setAdded(true);
                dialogOnly?.onAdded();
                setOpen(false);
              }
            }}
          >
            <Trans>Confirm and add event</Trans>
          </button>
        )}
      </div>
    </Dialog>
  );
  if (dialogOnly) return dialog;
  return (
    <section className="mt-3 space-y-2 rounded-card border border-blue-200 p-3 dark:border-blue-900">
      <h3 className="font-semibold">{event.title || message.subject}</h3>
      <p>
        {range}
        {shown.start.kind === "date" && <> · {t`All day`}</>}
      </p>
      {shown.endEstimated && (
        <p>
          <Trans>End time is estimated. Review it before adding the event.</Trans>
        </p>
      )}
      <button type="button" className={formButton} disabled={added} onClick={() => setOpen(true)}>
        {added ? t`Added to calendar` : t`Add to calendar`}
      </button>
      {dialog}
    </section>
  );
}
