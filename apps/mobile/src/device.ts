import { Mailbox } from "@openmail/core/portable";
import { Effect, type ManagedRuntime } from "effect";
import { AppState } from "react-native";
import { addNetworkStateListener, getNetworkStateAsync } from "expo-network";
export const isForeground = () => AppState.currentState === "active";
export async function deviceOnline() {
  const state = await getNetworkStateAsync();
  return state.isConnected === true && state.isInternetReachable !== false;
}

export function watchConnectivity(onActive: () => void, onBackground: () => void) {
  const app = AppState.addEventListener("change", (state) => {
    if (state === "active") onActive();
    else onBackground();
  });
  const network = addNetworkStateListener((state) => {
    if (isForeground() && state.isConnected && state.isInternetReachable !== false) onActive();
  });
  return {
    remove: () => {
      app.remove();
      network.remove();
    },
  };
}

export function resumeConnectivity(
  runtime: Pick<ManagedRuntime.ManagedRuntime<Mailbox, never>, "runPromise">,
  work: () => Promise<unknown>,
) {
  return runtime
    .runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.resetConnectivity()))
    .then(work);
}
