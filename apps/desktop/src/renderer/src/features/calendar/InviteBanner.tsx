import { plural } from "@lingui/core/macro";
import { ServiceHint, useServiceState } from "../accounts/OptionalServices";
import { Button } from "@base-ui/react/button";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  inviteCanRespond,
  shouldLoadInvitation,
  calendarRangeParts,
  formatCalendarTime,
  type CalendarInvite,
  type InviteResponse,
  type Provider,
  providerCapabilities,
} from "@openmail/core/schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Message } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { Keys } from "../../state/keys";
import { respondInviteAtom } from "../../state/mutations";
import { accountsAtom, invitationsAtom } from "../../state/queries";
import {
  CalendarAccessAction,
  calendarFailure,
  DetectedCalendarEvents,
  OverlappingEvents,
} from "./CalendarEvents";
import { MeetingLinks } from "./MeetingLinks";
import { NO_VALUE } from "../../i18n/message-text";
import { formButton } from "../../ui/form-styles";
import { Disclosure } from "../../ui/Disclosure";

export function InviteBanner({ message }: { message: Message }) {
  return (
    <>
      {shouldLoadInvitation(message) && <LoadedInvites message={message} />}
      <DetectedCalendarEvents message={message} />
    </>
  );
}

function LoadedInvites({ message }: { message: Message }) {
  const { i18n } = useLingui();
  const invitations = useAtomValue(invitationsAtom(message.id));
  const accounts = AsyncResult.getOrElse(useAtomValue(accountsAtom), () => []);
  const account = accounts.find((a) => a.id === message.accountId);
  if (invitations._tag === "Failure")
    return (
      <div
        role="alert"
        className="mt-3 rounded-control border border-orange-300 p-3 text-orange-700 dark:text-orange-400"
      >
        <Trans>Couldn't load the calendar invitation.</Trans> {resultError(i18n, invitations)}
      </div>
    );
  const invites = AsyncResult.getOrElse(invitations, () => []);
  return (
    <>
      {invites.map((invite) => (
        <Invitation
          key={`${invite.method}:${invite.key}`}
          message={message}
          invite={invite}
          email={account?.email ?? ""}
          provider={account?.provider ?? "imap"}
        />
      ))}
    </>
  );
}

/** Each side of the range stays whole when it fits, so a narrow card breaks at the arrow. */
function CalendarRange({ range }: { range: Pick<CalendarInvite, "start" | "end"> }) {
  const { i18n } = useLingui();
  const { start, end } = calendarRangeParts(range, i18n.locale);
  return end === null ? (
    start
  ) : (
    <>
      <span className="inline-block">{start} →</span> <span className="inline-block">{end}</span>
    </>
  );
}

function Recurrence({ invite }: { invite: CalendarInvite }) {
  const { t, i18n } = useLingui();
  if (!invite.recurrence.length && !invite.recurrenceId) return null;
  const rule = invite.recurrence.find((r) => r.startsWith("RRULE:")) ?? "";
  const frequency = /FREQ=([A-Z]+)/.exec(rule)?.[1];
  const interval = Math.max(1, Number(/INTERVAL=(\d+)/.exec(rule)?.[1] ?? 1));
  const count = /COUNT=(\d+)/.exec(rule)?.[1];
  const summary =
    interval > 1
      ? frequency === "DAILY"
        ? t`${plural(interval, { one: "Every # day", other: "Every # days" })}`
        : frequency === "WEEKLY"
          ? t`${plural(interval, { one: "Every # week", other: "Every # weeks" })}`
          : frequency === "MONTHLY"
            ? t`${plural(interval, { one: "Every # month", other: "Every # months" })}`
            : frequency === "YEARLY"
              ? t`${plural(interval, { one: "Every # year", other: "Every # years" })}`
              : t`Recurring meeting`
      : frequency === "DAILY"
        ? t`Repeats daily`
        : frequency === "WEEKLY"
          ? t`Repeats weekly`
          : frequency === "MONTHLY"
            ? t`Repeats monthly`
            : frequency === "YEARLY"
              ? t`Repeats yearly`
              : t`Recurring meeting`;
  return (
    <Disclosure
      summary={
        <>
          {invite.recurrenceId ? t`One occurrence of a recurring meeting` : summary}
          {count && (
            <> · {t`${plural(Number(count), { one: "# occurrence", other: "# occurrences" })}`}</>
          )}
        </>
      }
    >
      {invite.recurrenceId && <p>{formatCalendarTime(invite.recurrenceId, i18n.locale)}</p>}
      <ul className="break-words font-mono text-caption">
        {invite.recurrence.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </Disclosure>
  );
}

function Invitation({
  message,
  invite,
  email,
  provider,
}: {
  message: Message;
  invite: CalendarInvite;
  email: string;
  provider: Provider;
}) {
  const { t, i18n } = useLingui();
  const [result, respond] = useAtom(respondInviteAtom, { mode: "promiseExit" });
  const [sent, setSent] = useState<InviteResponse | null>(null);
  const attendeeAddress = invite.responseAddress?.address ?? email;
  const attendee = invite.attendees.find(
    (a) => a.address.toLowerCase() === attendeeAddress.toLowerCase(),
  );
  const current =
    !invite.threadStatus?.cancelled &&
    (invite.threadStatus?.sequence ?? invite.sequence) <= invite.sequence;
  const canRespond =
    current &&
    inviteCanRespond(
      invite,
      email,
      provider,
      invite.responseAddress ? [invite.responseAddress.address] : [],
    );
  // A turned-off or ungranted calendar fails every call; ServiceHint explains instead.
  const calendar = useServiceState(message.accountId, "calendar");
  const calendarOff = calendar !== undefined && calendar !== "granted";
  const recipient = !providerCapabilities(provider).calendar ? invite.organizer?.address : null;
  const state = sent ?? attendee?.status.toLowerCase();
  const responseLabel = (response: string) =>
    response === "accepted"
      ? t`Accepted`
      : response === "tentative"
        ? t`Tentative`
        : response === "declined"
          ? t`Declined`
          : null;
  const label = state === undefined ? null : responseLabel(state);
  return (
    <section
      aria-label={t`Calendar invitation`}
      className="mt-3 space-y-2 rounded-card border border-blue-200 bg-blue-50/70 p-3 text-footnote dark:border-blue-900 dark:bg-blue-950/30"
    >
      <p className="font-semibold">
        {invite.cancelled
          ? t`Meeting cancelled`
          : invite.method === "REPLY"
            ? t`Meeting response`
            : t`Calendar invitation`}
      </p>
      <h3 className="text-callout font-semibold">{invite.title || message.subject}</h3>
      {invite.start && (
        <p>
          <CalendarRange range={invite} />
          {invite.start.kind === "date" && <> · {t`All day`}</>}
        </p>
      )}
      {invite.previous && (
        <div className="space-y-1" aria-label={t`Invitation changes`}>
          <p className="font-medium">
            <Trans>Meeting updated</Trans>
          </p>
          <p>
            <Trans>Previous time:</Trans> <CalendarRange range={invite.previous} />
          </p>
          <p>
            <Trans>New time:</Trans> <CalendarRange range={invite} />
          </p>
          {invite.previous.location !== invite.location && (
            <p>
              <Trans>Location changed:</Trans> {invite.previous.location || i18n._(NO_VALUE)} →{" "}
              {invite.location || i18n._(NO_VALUE)}
            </p>
          )}
        </div>
      )}
      {invite.threadStatus && (
        <Disclosure summary={t`Invitation status in this conversation`}>
          {invite.threadStatus.cancelled ? (
            <p>{t`Meeting cancelled`}</p>
          ) : invite.threadStatus.sequence > invite.sequence ? (
            <p>{t`This invitation has a newer update`}</p>
          ) : null}
          <ul>
            {invite.threadStatus.statuses.map((a) => (
              <li key={a.address}>
                {a.name || a.address}:{" "}
                {a.status === "ACCEPTED"
                  ? t`Accepted`
                  : a.status === "TENTATIVE"
                    ? t`Tentative`
                    : a.status === "DECLINED"
                      ? t`Declined`
                      : t`Awaiting response`}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {invite.start?.kind === "floating" && (
        <p className="text-a11y-muted">
          <Trans>No time zone supplied; shown in your local time.</Trans>
        </p>
      )}
      {invite.start?.kind === "zoned" && invite.start.timestamp === null && (
        <p className="text-orange-700 dark:text-orange-400">
          <Trans>Unknown organizer time zone; showing the original time.</Trans>
        </p>
      )}
      <dl className="space-y-1">
        {invite.location && (
          <div>
            <dt className="inline font-medium">{t`Location:`} </dt>
            <dd className="inline">{invite.location}</dd>
          </div>
        )}
        {invite.organizer && (
          <div>
            <dt className="inline font-medium">{t`Organizer:`} </dt>
            <dd className="inline">
              {invite.organizer.name} &lt;{invite.organizer.address}&gt;
            </dd>
          </div>
        )}
        {!!invite.attendees.length && (
          <div>
            <dt className="inline font-medium">{t`Attendees:`} </dt>
            <dd className="inline">
              {new Intl.ListFormat(i18n.locale).format(
                invite.attendees.map((a) => {
                  const who = a.name ? `${a.name} <${a.address}>` : a.address;
                  const status =
                    invite.method !== "REPLY"
                      ? undefined
                      : a.status === "ACCEPTED"
                        ? t`Accepted`
                        : a.status === "TENTATIVE"
                          ? t`Tentative`
                          : a.status === "DECLINED"
                            ? t`Declined`
                            : a.status;
                  return a.optional
                    ? status
                      ? t`${who} (optional, ${status})`
                      : t`${who} (optional)`
                    : status
                      ? t`${who} (${status})`
                      : who;
                }),
              )}
            </dd>
          </div>
        )}
      </dl>
      {invite.organizerMismatch && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          <Trans>
            The organizer differs from the message sender. Check the response recipient before
            replying.
          </Trans>
        </p>
      )}
      {!invite.cancelled && (
        <MeetingLinks sources={[invite.location, invite.description ?? "", invite.url ?? ""]} />
      )}
      <Recurrence invite={invite} />
      {providerCapabilities(provider).calendar &&
        !calendarOff &&
        invite.method === "REQUEST" &&
        !invite.cancelled &&
        invite.start &&
        !(invite.start.kind === "zoned" && invite.start.timestamp === null) && (
          <OverlappingEvents
            accountId={message.accountId}
            messageId={message.id}
            inviteKey={invite.key}
          />
        )}
      {canRespond && !calendarOff && (
        <div className="flex flex-wrap items-center gap-2">
          {(
            [
              { response: "accepted", text: t`Accept` },
              { response: "tentative", text: t`Tentative` },
              { response: "declined", text: t`Decline` },
            ] satisfies { response: InviteResponse; text: string }[]
          ).map(({ response, text }) => (
            <Button
              key={response}
              className={`${formButton} max-w-full min-w-24 break-words`}
              disabled={result.waiting}
              onClick={async () => {
                const exit = await respond({
                  payload: {
                    messageId: message.id,
                    key: invite.key,
                    response,
                    // An IMAP reply's subject names the response in the app language.
                    label: responseLabel(response) ?? response,
                  },
                  reactivityKeys: [Keys.audit],
                });
                if (exit._tag === "Success") setSent(response);
              }}
            >
              {recipient ? t`${text} → ${recipient}` : text}
            </Button>
          ))}
          {label && <output>{label}</output>}
        </div>
      )}
      {resultError(i18n, result) && (
        <p role="alert" className="text-orange-700 dark:text-orange-400">
          {resultError(i18n, result)}
        </p>
      )}
      <ServiceHint accountId={message.accountId} service="calendar" />
      <CalendarAccessAction accountId={message.accountId} error={calendarFailure(result)} />
    </section>
  );
}
