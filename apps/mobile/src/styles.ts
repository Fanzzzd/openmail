import { StyleSheet } from "react-native";

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#ffffff" },
  center: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#ffffff",
  },
  title: { color: "#16181d", fontSize: 30, fontWeight: "600", padding: 20 },
  row: {
    minHeight: 68,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomColor: "#e2e4e9",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subject: { color: "#16181d", fontSize: 17, fontWeight: "600" },
  detail: { color: "#5f6571", fontSize: 15, lineHeight: 22, marginTop: 4 },
  action: { color: "#1f4fd1", fontSize: 17, paddingVertical: 14 },
  button: { minHeight: 48, paddingHorizontal: 20 },
  muted: { opacity: 0.45 },
  empty: { color: "#5f6571", padding: 24, fontSize: 16 },
  error: { color: "#b42318", padding: 20, fontSize: 16 },
  body: { color: "#16181d", fontSize: 16, lineHeight: 25, marginTop: 16 },
  message: { padding: 20, borderBottomColor: "#e2e4e9", borderBottomWidth: 1 },
  webview: { height: 480, backgroundColor: "#ffffff" },
});
