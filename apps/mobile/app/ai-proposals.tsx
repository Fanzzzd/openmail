import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLingui } from "@lingui/react";
import { router } from "expo-router";
import { Mailbox, type Proposal } from "@openmail/core/portable";
import { Effect } from "effect";
import { useMailbox, useMailboxQuery } from "../src/mailbox";
import { Button } from "../src/controls";
import { styles } from "../src/styles";

function ProposalReview({ proposal }: { proposal: Proposal }) {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const command = proposal.command;
  const detail = useMailboxQuery(
    useCallback(
      () =>
        runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) =>
            Effect.gen(function* () {
              if (command.kind !== "modify") return [];
              const labels = yield* mailbox.reading.labels();
              const descriptions: string[] = [];
              for (const id of command.threads) {
                const messages = yield* mailbox.reading.thread(id);
                const message = messages[0];
                if (!message) throw new Error("Missing proposal thread");
                const op = command.op;
                const label =
                  op.kind === "label"
                    ? labels.find(
                        (entry) => entry.accountId === message.accountId && entry.id === op.labelId,
                      )?.name
                    : "";
                if (command.op.kind === "label" && !label)
                  throw new Error("Missing proposal label");
                descriptions.push(`${message.subject}\n${id}${label ? `\n${label}` : ""}`);
              }
              return descriptions;
            }),
          ),
        ),
      [runtime, command],
    ),
  );
  const decide = async (approve: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const outcome = await runtime.runPromise(
        Effect.flatMap(Mailbox, (mailbox) => mailbox.decideProposal(proposal.id, approve, "app")),
      );
      if (outcome.status !== "applied") throw new Error("Proposal not applied");
      if (approve && command.kind === "draft")
        router.push({
          pathname: "/compose",
          params: { accountId: command.accountId, draftId: `proposal:${proposal.id}` },
        });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const supported =
    command.kind === "draft" ||
    (command.kind === "modify" &&
      (command.op.kind === "archive" || (command.op.kind === "label" && command.op.value)));
  if (!supported) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.subject}>
        {command.kind === "draft"
          ? i18n._({ id: "Draft", message: "Draft" })
          : command.op.kind === "archive"
            ? i18n._({ id: "Archive", message: "Archive" })
            : i18n._({ id: "Labels", message: "Labels" })}
      </Text>
      {proposal.actor.kind === "agent" && proposal.actor.rationale && (
        <Text selectable style={styles.detail}>
          {proposal.actor.rationale}
        </Text>
      )}
      {detail.kind === "ready" &&
        detail.value.map((text) => (
          <Text key={text} selectable style={styles.body}>
            {text}
          </Text>
        ))}
      {command.kind === "draft" && (
        <>
          <Text selectable>{command.accountId}</Text>
          {command.message.from && <Text selectable>{command.message.from.address}</Text>}
          {(
            [
              { field: "to", label: i18n._({ id: "To", message: "To" }) },
              { field: "cc", label: i18n._({ id: "Cc", message: "Cc" }) },
              { field: "bcc", label: i18n._({ id: "Bcc", message: "Bcc" }) },
            ] as const
          ).map(({ field, label }) => (
            <Text key={field} selectable>
              {label}:{" "}
              {command.message[field]
                .map((address) => `${address.name} <${address.address}>`)
                .join(", ")}
            </Text>
          ))}
          <Text selectable style={styles.subject}>
            {command.message.subject}
          </Text>
          <Text selectable style={styles.body}>
            {command.message.text}
          </Text>
        </>
      )}
      <Button
        disabled={busy || detail.kind !== "ready"}
        label={i18n._({ id: "Approve", message: "Approve" })}
        onPress={() => void decide(true)}
      />
      <Button
        disabled={busy}
        label={i18n._({ id: "Reject", message: "Reject" })}
        onPress={() => void decide(false)}
      />
      {(failed || detail.kind === "failed") && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not apply action. Try again.",
            message: "Could not apply action. Try again.",
          })}
        </Text>
      )}
    </View>
  );
}
export default function AiProposals() {
  const runtime = useMailbox();
  const { i18n } = useLingui();
  const proposals = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.proposals)),
      [runtime],
    ),
  );
  return (
    <ScrollView style={styles.screen}>
      <Text style={styles.title}>
        {i18n._({ id: "Review proposals", message: "Review proposals" })}
      </Text>
      {proposals.kind === "ready" &&
        proposals.value
          .filter(
            (proposal) =>
              proposal.actor.kind === "agent" &&
              proposal.actor.surface === "rule" &&
              proposal.actor.name === "openmail-assistant",
          )
          .map((proposal) => <ProposalReview key={proposal.id} proposal={proposal} />)}
      {proposals.kind === "failed" && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({
            id: "Could not load mail. Try again.",
            message: "Could not load mail. Try again.",
          })}
        </Text>
      )}
    </ScrollView>
  );
}
