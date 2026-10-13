import {
  recipientLabel,
  type MailOp,
  type Prefs,
  type SwipeAction,
  type ThreadSummary,
} from "@openmail/core/portable";
import { Pressable, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from "react-native-reanimated";
import { useLingui } from "@lingui/react";
import { swipeAction } from "./workflows";
import { actionLabels } from "./labels";
import { styles } from "./styles";
export function ThreadRow({
  row,
  prefs,
  selected,
  selecting,
  open,
  menu,
  select,
  action,
  accessibleAction,
}: {
  row: ThreadSummary;
  prefs: Prefs["swipeActions"];
  selected: boolean;
  selecting: boolean;
  open: () => void;
  menu: () => void;
  select: () => void;
  action: (action: SwipeAction) => void;
  accessibleAction: (op: MailOp) => void;
}) {
  const { i18n } = useLingui();
  const names = actionLabels(i18n);
  const offset = useSharedValue(0);
  const animated = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  // oxlint-disable-next-line react/capitalized-calls -- Gesture.Pan builds a native recognizer, not a React component.
  const gesture = Gesture.Pan()
    .enabled(!selecting)
    .activeOffsetX([-15, 15])
    .failOffsetY([-10, 10])
    .runOnJS(true)
    .onUpdate((event) => {
      offset.set(event.translationX);
    })
    .onEnd((event) => {
      action(swipeAction(event.translationX, prefs));
    })
    .onFinalize(() => {
      offset.set(withTiming(0));
    });
  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={animated}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected }}
          accessibilityLabel={[
            row.subject,
            recipientLabel(row.from, false),
            row.isUnread ? names.unread : names.read,
            row.isStarred ? names.star : "",
          ]
            .filter(Boolean)
            .join(", ")}
          accessibilityActions={[
            ...(["archive", "trash", "read", "unread", "star", "unstar", "snooze"] as const).map(
              (name) => ({
                name,
                label: names[name],
              }),
            ),
            { name: "menu", label: i18n._({ id: "Actions", message: "Actions" }) },
            { name: "select", label: names.select },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === "select") select();
            else if (nativeEvent.actionName === "menu") menu();
            else if (nativeEvent.actionName === "read" || nativeEvent.actionName === "unread")
              accessibleAction({ kind: "read", value: nativeEvent.actionName === "read" });
            else if (nativeEvent.actionName === "star" || nativeEvent.actionName === "unstar")
              accessibleAction({ kind: "star", value: nativeEvent.actionName === "star" });
            else
              for (const name of ["archive", "trash", "snooze"] as const)
                if (name === nativeEvent.actionName) action(name);
          }}
          onLongPress={menu}
          onPress={selecting ? select : open}
          style={[styles.row, selected && styles.selected]}
        >
          <View>
            <Text
              style={[styles.subject, !row.isUnread && { fontWeight: "400" }]}
              numberOfLines={1}
            >
              {row.isStarred ? "★ " : ""}
              {row.subject || i18n._({ id: "(No subject)", message: "(No subject)" })}
            </Text>
            <Text style={styles.detail}>{recipientLabel(row.from, false)}</Text>
            <Text style={styles.detail} numberOfLines={2}>
              {row.snippet}
            </Text>
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}
