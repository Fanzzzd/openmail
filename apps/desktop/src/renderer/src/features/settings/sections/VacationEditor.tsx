import type { Account } from "../../../../../shared/api";
import { escapeHtml, htmlToText, type Vacation } from "@openmail/core/schema";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { useAtom } from "@effect/atom-react";
import { setVacationAtom } from "../../../state/mutations";
import { Dialog } from "../../../ui/Dialog";
import { Keys } from "../../../state/keys";
import { Checkbox } from "../../../ui/Checkbox";
import { fieldLabel } from "./server-settings-styles";
import { buttonPrimary, formInput, settingsHint } from "../../../ui/styles";
import { Select } from "../../../ui/Select";
import { resultError } from "../../../lib/errors";

const datetime = (ms: number | null) =>
  ms === null
    ? ""
    : new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export function VacationEditor({
  account,
  initial,
  onClose,
}: {
  account: Account;
  initial: Vacation;
  onClose: () => void;
}) {
  const { t, i18n } = useLingui();
  const [input, setInput] = useState(initial);
  const [internalBody, setInternalBody] = useState(() =>
    htmlToText(initial.outlook?.internalReplyMessage ?? ""),
  );
  const [result, save] = useAtom(setVacationAtom, { mode: "promiseExit" });
  const replies = input.outlook ?? {
    externalAudience: "none",
    internalReplyMessage: "",
    externalReplyMessage: "",
  };
  return (
    <Dialog aria-label={t`Automatic replies`} onClose={onClose} className="w-[480px] p-5">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const exit = await save({
            payload: { accountId: account.id, input },
            reactivityKeys: [Keys.serverSettings, Keys.audit],
          });
          if (exit._tag === "Success") onClose();
        }}
      >
        <h2 className="text-headline font-semibold">
          <Trans>Automatic replies</Trans>
        </h2>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={input.enabled}
            onCheckedChange={(enabled) => setInput({ ...input, enabled })}
          />
          <span>{t`Enabled`}</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={fieldLabel}>{t`Start`}</span>
            <input
              className={formInput}
              type="datetime-local"
              value={datetime(input.start)}
              onChange={(e) =>
                setInput({
                  ...input,
                  start: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </label>
          <label className="block">
            <span className={fieldLabel}>{t`End`}</span>
            <input
              className={formInput}
              type="datetime-local"
              value={datetime(input.end)}
              onChange={(e) =>
                setInput({
                  ...input,
                  end: e.target.value ? new Date(e.target.value).getTime() : null,
                })
              }
            />
          </label>
        </div>
        {account.provider === "gmail" ? (
          <label className="block">
            <span className={fieldLabel}>{t`Subject`}</span>
            <input
              className={formInput}
              value={input.subject}
              onChange={(e) => setInput({ ...input, subject: e.target.value })}
            />
          </label>
        ) : (
          <p className={settingsHint}>
            <Trans>Outlook chooses the reply subject.</Trans>
          </p>
        )}
        <label className="block">
          <span className={fieldLabel}>{t`Message`}</span>
          <textarea
            rows={6}
            className={formInput}
            value={input.body}
            onChange={(e) => setInput({ ...input, body: e.target.value })}
          />
        </label>
        {account.provider === "gmail" ? (
          <label className="flex items-center gap-2">
            <Checkbox
              checked={input.contactsOnly}
              onCheckedChange={(contactsOnly) => setInput({ ...input, contactsOnly })}
            />
            <span>{t`Reply only to contacts`}</span>
          </label>
        ) : (
          <>
            <Select
              aria-label={t`External replies`}
              variant="field"
              value={replies.externalAudience}
              onValueChange={(externalAudience) =>
                setInput({
                  ...input,
                  contactsOnly: externalAudience === "contactsOnly",
                  outlook: { ...replies, externalAudience },
                })
              }
              options={[
                { value: "none", label: t`No external replies` },
                { value: "contactsOnly", label: t`Contacts only` },
                { value: "all", label: t`Everyone` },
              ]}
            />
            <label className="block">
              <span className={fieldLabel}>{t`Internal reply`}</span>
              <textarea
                rows={4}
                className={formInput}
                value={internalBody}
                onChange={(e) => {
                  setInternalBody(e.target.value);
                  setInput({
                    ...input,
                    outlook: {
                      ...replies,
                      internalReplyMessage: `<p>${escapeHtml(e.target.value).replaceAll("\n", "<br>")}</p>`,
                    },
                  });
                }}
              />
            </label>
          </>
        )}
        {resultError(i18n, result) && (
          <p role="alert" className="text-a11y-danger">
            {resultError(i18n, result)}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <button type="submit" className={buttonPrimary} disabled={result.waiting}>
            <Trans>Save</Trans>
          </button>
        </div>
      </form>
    </Dialog>
  );
}
