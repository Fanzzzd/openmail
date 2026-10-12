import { useAtom } from "@effect/atom-react";
import { useLingui } from "@lingui/react/macro";
import type { Label } from "../../../../shared/api";
import { resultError } from "../../lib/errors";
import { MAIL_KEYS } from "../../state/keys";
import { createLabelAndApplyAtom } from "../../state/mutations";
import { LabelEditor } from "./OrganizationSettings";

export interface LabelApplyTarget {
  accountId: string;
  threads: readonly string[];
  move: boolean;
  removeLabelId: string | null;
  flat: boolean;
}

export function CreateLabelDialog({
  target,
  labels,
  onClose,
}: {
  target: LabelApplyTarget;
  labels: readonly Label[];
  onClose: () => void;
}) {
  const { i18n } = useLingui();
  const [result, create] = useAtom(createLabelAndApplyAtom, { mode: "promiseExit" });
  return (
    <LabelEditor
      label="new"
      labels={labels.filter((l) => l.accountId === target.accountId)}
      busy={result.waiting}
      error={resultError(i18n, result)}
      onClose={onClose}
      onSave={async (change) => {
        if (change.kind !== "create") return;
        const exit = await create({
          payload: { ...target, name: change.name, parentId: change.parentId ?? null },
          reactivityKeys: MAIL_KEYS,
        });
        if (exit._tag === "Success") onClose();
      }}
    />
  );
}
