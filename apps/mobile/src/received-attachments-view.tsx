import type { Message } from "@openmail/core/portable";
import { useLingui } from "@lingui/react";
import { Text } from "react-native";
import { Button } from "./controls";
import { styles } from "./styles";

export function ReceivedAttachments({
  attachments,
  busy,
  onOpen,
}: {
  attachments: Message["attachments"];
  busy: boolean;
  onOpen: (index: number) => void;
}) {
  const { i18n } = useLingui();
  return (
    <>
      {attachments.map((attachment, index) => (
        <Button
          key={`${index}:${attachment.filename}`}
          disabled={busy}
          label={i18n._({
            id: "Open or share {filename}",
            message: "Open or share {filename}",
            values: { filename: attachment.filename },
          })}
          onPress={() => onOpen(index)}
        />
      ))}
      {attachments.some((attachment) => attachment.mimeType === "application/pdf") && (
        <Text style={styles.detail}>
          {i18n._({
            id: "PDF text extraction is unavailable on mobile.",
            message: "PDF text extraction is unavailable on mobile.",
          })}
        </Text>
      )}
    </>
  );
}
