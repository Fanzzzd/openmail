import { AppState } from "react-native";
import { getNetworkStateAsync } from "expo-network";
export const isForeground = () => AppState.currentState === "active";
export async function deviceOnline() {
  const state = await getNetworkStateAsync();
  return state.isConnected === true && state.isInternetReachable !== false;
}
