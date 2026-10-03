import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useLingui } from "@lingui/react";
import { Button } from "./controls";
import { styles } from "./styles";
import { createUndoController, type NoticeChannel } from "./undo-state";
type Controller = ReturnType<typeof createUndoController>;
const Context = createContext<Controller | null>(null);
function UndoToast({ controller, channel }: { controller: Controller; channel: NoticeChannel }) {
  const { i18n } = useLingui();
  const toast = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  )[channel];
  useEffect(() => {
    const timer = toast
      ? setTimeout(
          () => controller.dismiss(channel, toast.notice),
          Math.max(0, toast.notice.until - Date.now()),
        )
      : null;
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [toast, controller, channel]);
  if (!toast) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.toast}>
      <Text>{toast.notice.text}</Text>
      {toast.notice.kind === "undo" && (
        <Button
          disabled={toast.status === "busy"}
          label={i18n._({ id: "Undo", message: "Undo" })}
          onPress={() => void controller.undo(channel)}
        />
      )}
      {toast.status === "failed" && (
        <Text accessibilityRole="alert" style={styles.error}>
          {i18n._({ id: "Could not undo. Try again.", message: "Could not undo. Try again." })}
        </Text>
      )}
    </View>
  );
}
export function UndoProvider({ children }: { children: ReactNode }) {
  const controller = useMemo(() => createUndoController(), []);
  return (
    <Context.Provider value={controller}>
      {children}
      <UndoToast channel="send" controller={controller} />
      <UndoToast channel="thread" controller={controller} />
    </Context.Provider>
  );
}
export function useUndo(channel: NoticeChannel = "thread") {
  const controller = useContext(Context);
  if (!controller) throw new Error("UndoProvider missing");
  return (notice: Parameters<Controller["show"]>[1]) => controller.show(channel, notice);
}
