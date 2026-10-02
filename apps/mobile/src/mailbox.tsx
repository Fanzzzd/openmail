import { Mailbox } from "@openmail/core/portable";
import { Effect, ManagedRuntime, Stream } from "effect";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useLingui } from "@lingui/react";
import { mobileMailboxLayer } from "./platform";
import { styles } from "./styles";

type MobileRuntime = ReturnType<typeof createRuntime>;
const createRuntime = () => ManagedRuntime.make(mobileMailboxLayer());
const RuntimeContext = createContext<MobileRuntime | null>(null);
const RevisionContext = createContext(0);
export function MailboxProvider({ children }: { children: ReactNode }) {
  const { i18n } = useLingui();
  const [runtime, setRuntime] = useState<MobileRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    let instance: MobileRuntime | null = null;
    const initialize = async () => {
      await Promise.resolve();
      if (!isActive()) return;
      try {
        instance = createRuntime();
        await instance.runPromise(Mailbox);
        if (isActive()) {
          setRuntime(instance);
          setReady(true);
        }
        const events = Effect.flatMap(Mailbox, (mailbox) =>
          Stream.runForEach(mailbox.events, (event) =>
            Effect.sync(() => {
              if (isActive() && event._tag === "Changed") setRevision((value) => value + 1);
            }),
          ),
        );
        if (isActive()) instance.runFork(events);
      } catch {
        if (isActive())
          setError(
            i18n._({
              id: "Could not open the local mail database.",
              message: "Could not open the local mail database.",
            }),
          );
      }
    };
    void initialize();
    return () => {
      active = false;
      if (instance) void instance.dispose();
    };
  }, [i18n]);
  if (error)
    return (
      <View style={styles.center}>
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      </View>
    );
  if (!ready || !runtime)
    return (
      <View style={styles.center}>
        <ActivityIndicator accessibilityLabel={i18n._({ id: "Loading…", message: "Loading…" })} />
      </View>
    );
  return (
    <RuntimeContext.Provider value={runtime}>
      <RevisionContext.Provider value={revision}>{children}</RevisionContext.Provider>
    </RuntimeContext.Provider>
  );
}
export function useMailbox() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("MailboxProvider is missing");
  return runtime;
}
export const useMailboxRevision = () => useContext(RevisionContext);

type QueryState<A> = { kind: "loading" } | { kind: "ready"; value: A } | { kind: "failed" };
export function useMailboxQuery<A>(load: () => Promise<A>) {
  const revision = useMailboxRevision();
  const [result, setResult] = useState<{
    load: typeof load;
    revision: number;
    state: QueryState<A>;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const value = await load();
        if (active) setResult({ load, revision, state: { kind: "ready", value } });
      } catch {
        if (active) setResult({ load, revision, state: { kind: "failed" } });
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [load, revision]);
  const loading: QueryState<A> = { kind: "loading" };
  return result?.load === load && result.revision === revision ? result.state : loading;
}
