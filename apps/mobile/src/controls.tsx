import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { styles } from "./styles";
export function Button({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={[styles.button, disabled && styles.muted]}
      onPress={onPress}
    >
      <Text style={styles.action}>{label}</Text>
    </Pressable>
  );
}
export function Sheet({
  title,
  children,
  close,
  cancel,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  cancel: string;
}) {
  return (
    <Modal transparent animationType="slide" onRequestClose={close}>
      <View style={styles.sheetBackdrop}>
        <View accessibilityViewIsModal style={styles.sheet}>
          <Text style={styles.subject}>{title}</Text>
          <ScrollView>{children}</ScrollView>
          <Button label={cancel} onPress={close} />
        </View>
      </View>
    </Modal>
  );
}
