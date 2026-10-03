import { useCallback, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLingui } from "@lingui/react";
import DateTimePicker from "@react-native-community/datetimepicker";
import { Mailbox, type MailOp } from "@openmail/core/portable";
import { Effect } from "effect";
import { useMailbox, useMailboxQuery } from "./mailbox";
import { Button, Sheet } from "./controls";
import { actionLabels } from "./labels";
import { modifyThreads, labelDestinations } from "./workflows";
import { batchNotice } from "./undo-state";
import { useUndo } from "./undo";
import { styles } from "./styles";
import { mailboxName } from "./mailbox-name";

export function useThreadActions() {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const notice = useUndo();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const apply = async (ids: readonly string[], op: MailOp | { kind: "snooze"; due: number }) => {
    if (pending.current || !ids.length) return false;
    pending.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) =>
          op.kind === "snooze"
            ? mailbox.snoozeWithUndo(ids, op.due)
            : modifyThreads(mailbox, ids, op),
        ),
      );
      notice(
        batchNotice({
          undoId: result.undoId,
          text: i18n._({ id: "Done", message: "Done" }),
          until: Date.now() + 10000,
          undo: () =>
            runtime.runPromise(
              Effect.flatMap(Mailbox, (mailbox) => mailbox.undoBatch(result.undoId)),
            ),
        }),
      );
      return true;
    } catch {
      setFailed(true);
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return { apply, busy, failed };
}
export function ThreadMenu({
  ids,
  accountId,
  label,
  close,
}: {
  ids: readonly string[];
  accountId: string;
  label?: string;
  close: () => void;
}) {
  const { i18n } = useLingui();
  const runtime = useMailbox();
  const names = actionLabels(i18n);
  const actions = useThreadActions();
  const [panel, setPanel] = useState<"main" | "labels" | "snooze">("main");
  const [date, setDate] = useState(() => new Date(Date.now() + 3600000));
  const [now] = useState(Date.now);
  const [picker, setPicker] = useState<"date" | "time" | null>(null);
  const accounts = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.accounts)),
      [runtime],
    ),
  );
  const labels = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.labels([accountId]))),
      [runtime, accountId],
    ),
  );
  const snoozed = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            Effect.forEach(ids, (id) => mailbox.thread(id)).pipe(
              Effect.map((threads) =>
                threads.some((messages) =>
                  messages.some((message) => message.labels.includes("SNOOZED")),
                ),
              ),
            ),
          ),
        ),
      [runtime, ids],
    ),
  );
  const account =
    accounts.kind === "ready" ? accounts.value.find((entry) => entry.id === accountId) : undefined;
  const apply = async (op: MailOp | { kind: "snooze"; due: number }) => {
    if (await actions.apply(ids, op)) close();
  };
  const chooseLabel = (id: string) =>
    apply(
      account?.provider === "gmail"
        ? { kind: "label", labelId: id, value: true }
        : { kind: "move", labelId: id, removeLabelId: label ?? null },
    );
  return (
    <Sheet
      title={i18n._({ id: "Actions", message: "Actions" })}
      close={close}
      cancel={names.cancel}
    >
      {panel === "main" && (
        <>
          {(["archive", "trash"] as const).map((kind) => (
            <Button
              key={kind}
              disabled={actions.busy}
              label={names[kind]}
              onPress={() => void apply({ kind })}
            />
          ))}
          <Button
            disabled={actions.busy}
            label={names.read}
            onPress={() => void apply({ kind: "read", value: true })}
          />
          <Button
            disabled={actions.busy}
            label={names.unread}
            onPress={() => void apply({ kind: "read", value: false })}
          />
          <Button
            disabled={actions.busy}
            label={names.star}
            onPress={() => void apply({ kind: "star", value: true })}
          />
          <Button
            disabled={actions.busy}
            label={names.unstar}
            onPress={() => void apply({ kind: "star", value: false })}
          />
          <Button
            label={account?.provider === "gmail" ? names.label : names.move}
            onPress={() => setPanel("labels")}
          />
          <Button label={names.snooze} onPress={() => setPanel("snooze")} />
          {snoozed.kind === "ready" && snoozed.value && (
            <Button
              disabled={actions.busy}
              label={i18n._({ id: "Unsnooze", message: "Unsnooze" })}
              onPress={() => void apply({ kind: "inbox" })}
            />
          )}
        </>
      )}
      {panel === "labels" &&
        labels.kind === "ready" &&
        labelDestinations(account?.provider ?? "gmail", labels.value).map((item) => (
          <View key={item.id}>
            <Button label={mailboxName(i18n, item)} onPress={() => void chooseLabel(item.id)} />
            {account?.provider === "gmail" && (
              <Button
                label={i18n._({ id: "Remove label", message: "Remove label" })}
                onPress={() => void apply({ kind: "label", labelId: item.id, value: false })}
              />
            )}
          </View>
        ))}
      {panel === "snooze" && (
        <>
          <Button
            label={i18n._({ id: "Later today", message: "Later today" })}
            onPress={() => void apply({ kind: "snooze", due: Date.now() + 3 * 3600000 })}
          />
          <Button
            label={i18n._({ id: "Tomorrow", message: "Tomorrow" })}
            onPress={() => {
              const next = new Date();
              next.setDate(next.getDate() + 1);
              next.setHours(9, 0, 0, 0);
              void apply({ kind: "snooze", due: next.getTime() });
            }}
          />
          <Button
            label={i18n._({ id: "Next week", message: "Next week" })}
            onPress={() => {
              const next = new Date();
              next.setDate(next.getDate() + 7);
              next.setHours(9, 0, 0, 0);
              void apply({ kind: "snooze", due: next.getTime() });
            }}
          />
          <Button
            label={i18n._({ id: "Choose date", message: "Choose date" })}
            onPress={() => setPicker("date")}
          />
          <Button
            label={i18n._({ id: "Choose time", message: "Choose time" })}
            onPress={() => setPicker("time")}
          />
          <Text>
            {i18n.date(date)} {i18n.date(date, { hour: "numeric", minute: "numeric" })}
          </Text>
          {picker && (
            <DateTimePicker
              value={date}
              mode={picker}
              minimumDate={new Date(now)}
              onChange={(_, value) => {
                setPicker(null);
                if (value) setDate(value);
              }}
            />
          )}
          <Button
            disabled={actions.busy || date.getTime() <= now}
            label={names.snooze}
            onPress={() => void apply({ kind: "snooze", due: date.getTime() })}
          />
        </>
      )}
      {(actions.failed || labels.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not apply action. Try again.",
            message: "Could not apply action. Try again.",
          })}
        </Text>
      )}
    </Sheet>
  );
}
