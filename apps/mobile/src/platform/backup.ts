import { requireNativeModule } from "expo";
import { Platform } from "react-native";
/** iOS must acknowledge backup exclusion before a database can be opened. */
export function excludeMailBackup(uri: string): void {
  if (Platform.OS === "ios") {
    requireNativeModule<{ excludeFromBackup: (uri: string) => void }>(
      "OpenmailStorage",
    ).excludeFromBackup(uri);
  }
}
