import { Button } from "@base-ui/react/button";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  inviteCanRespond,
  shouldLoadInvitation,
  formatCalendarRange,
  formatCalendarTime,
  type CalendarInvite,
  type InviteResponse,
  type Provider,
} from "@openmail/core/schema";
import { Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import type { Message } from "../../../shared/api";
import { resultError } from "../errors";
import { Keys } from "../state/keys";
import { reauthAtom, respondInviteAtom } from "../state/mutations";
import { accountsAtom, invitationsAtom } from "../state/queries";
import { DetectedCalendarEvents, OverlappingEvents } from "./CalendarEvents";
import { MeetingLinks } from "./MeetingLinks";
import { formButton } from "./OrganizationSettings";

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
      <div role="alert" className="mt-3 rounded-md border border-orange-300 p-3 text-orange-600">
        <Trans>Could not load the calendar invitation.</Trans> {resultError(i18n, invitations)}
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
        ? t`Every ${interval} days`
        : frequency === "WEEKLY"
          ? t`Every ${interval} weeks`
          : frequency === "MONTHLY"
            ? t`Every ${interval} months`
            : frequency === "YEARLY"
              ? t`Every ${interval} years`
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
    <details>
      <summary className="cursor-pointer">
        {invite.recurrenceId ? t`One occurrence of a recurring meeting` : summary}
        {count && <> · {t`${count} occurrences`}</>}
      </summary>
      {invite.recurrenceId && <p>{formatCalendarTime(invite.recurrenceId, i18n.locale)}</p>}
      <ul className="break-words font-mono text-[11px]">
        {invite.recurrence.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </details>
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
  const [signIn, reauth] = useAtom(reauthAtom(message.accountId), { mode: "promiseExit" });
  const [sent, setSent] = useState<InviteResponse | null>(null);
  const attendeeAddress = invite.responseAddress?.address ?? email;
  const attendee = invite.attendees.find(
    (a) => a.address.toLowerCase() === attendeeAddress.toLowerCase(),
  );
  const canRespond = inviteCanRespond(
    invite,
    email,
    provider,
    invite.responseAddress ? [invite.responseAddress.address] : [],
  );
  const recipient = provider === "imap" ? invite.organizer?.address : null;
  const error = result._tag === "Failure" ? Cause.findErrorOption(result.cause) : null;
  const missing = error?._tag === "Some" && error.value._tag === "FeatureScopeMissing";
  const state = sent ?? attendee?.status.toLowerCase();
  const label =
    state === "accepted"
      ? t`Accepted`
      : state === "tentative"
        ? t`Tentative`
        : state === "declined"
          ? t`Declined`
          : null;
  return (
    <section
      aria-label={t`Calendar invitation`}
      className="mt-3 space-y-2 rounded-lg border border-blue-200 bg-blue-50/70 p-3 text-[12px] dark:border-blue-900 dark:bg-blue-950/30"
    >
      <p className="font-semibold">
        {invite.cancelled
          ? t`Meeting cancelled`
          : invite.method === "REPLY"
            ? t`Meeting response`
            : t`Calendar invitation`}
      </p>
      <h3 className="text-[14px] font-semibold">{invite.title || message.subject}</h3>
      {invite.start && (
        <p>
          {formatCalendarRange(invite, i18n.locale)}
          {invite.start.kind === "date" && <> · {t`All day`}</>}
        </p>
      )}
      {invite.start?.kind === "floating" && (
        <p className="text-neutral-500">
          <Trans>No time zone supplied; shown in your local time.</Trans>
        </p>
      )}
      {invite.start?.kind === "zoned" && invite.start.timestamp === null && (
        <p className="text-orange-600">
          <Trans>Unknown organizer time zone; showing the original time.</Trans>
        </p>
      )}
      <dl className="space-y-1">
        {invite.location && (
          <div>
            <dt className="inline font-medium">{t`Location`}: </dt>
            <dd className="inline">{invite.location}</dd>
          </div>
        )}
        {invite.organizer && (
          <div>
            <dt className="inline font-medium">{t`Organizer`}: </dt>
            <dd className="inline">
              {invite.organizer.name} &lt;{invite.organizer.address}&gt;
            </dd>
          </div>
        )}
        {!!invite.attendees.length && (
          <div>
            <dt className="inline font-medium">{t`Attendees`}: </dt>
            <dd className="inline">
              {invite.attendees
                .map(
                  (a) =>
                    `${a.name ? `${a.name} <${a.address}>` : a.address}${invite.method === "REPLY" ? ` (${a.status === "ACCEPTED" ? t`Accepted` : a.status === "TENTATIVE" ? t`Tentative` : a.status === "DECLINED" ? t`Declined` : a.status})` : ""}`,
                )
                .join(", ")}
            </dd>
          </div>
        )}
      </dl>
      {provider === "imap" && invite.organizerMismatch && (
        <p role="alert" className="text-orange-600">
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
      {provider !== "imap" &&
        invite.method === "REQUEST" &&
        !invite.cancelled &&
        invite.start &&
        !(invite.start.kind === "zoned" && invite.start.timestamp === null) && (
          <OverlappingEvents messageId={message.id} inviteKey={invite.key} />
        )}
      {canRespond && (
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
              className={`${formButton} max-w-full break-all text-left`}
              disabled={result.waiting || signIn.waiting}
              onClick={async () => {
                const exit = await respond({
                  payload: { messageId: message.id, key: invite.key, response },
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
        <p role="alert" className="text-orange-600">
          {resultError(i18n, result)}
        </p>
      )}
      {missing && (
        <Button
          className={formButton}
          disabled={signIn.waiting}
          onClick={async () => {
            await reauth();
          }}
        >
          <Trans>Sign in again</Trans>
        </Button>
      )}
      {resultError(i18n, signIn) && (
        <p role="alert" className="text-orange-600">
          {resultError(i18n, signIn)}
        </p>
      )}
    </section>
  );
}
