import { Mailbox, MobileDatabaseRecovery, type MobileDatabaseState } from "@openmail/core/portable";
import { Effect, ManagedRuntime, Stream } from "effect";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import type { I18n } from "@lingui/core";
import { useLingui } from "@lingui/react";
import { mobileMailboxLayer } from "./platform";
import { styles } from "./styles";
import { databaseRecoveryRuntime } from "./platform/database-recovery";
import { Button } from "./controls";

type MobileRuntime = ReturnType<typeof createRuntime>;
const createRuntime = (inspection: MobileDatabaseState) =>
  ManagedRuntime.make(mobileMailboxLayer(inspection));
const runRecovery = <A, E>(
  use: (recovery: MobileDatabaseRecovery["Service"]) => Effect.Effect<A, E>,
) => databaseRecoveryRuntime().runPromise(Effect.flatMap(MobileDatabaseRecovery, use));

function recoveryDetail(state: MobileDatabaseState, i18n: I18n): string {
  switch (state.kind) {
    case "recovered":
      if (Platform.OS === "ios")
        return i18n._({
          id: "Recovered {copied} local records. Skipped {skipped} unreadable items.",
          message: "Recovered {copied} local records. Skipped {skipped} unreadable items.",
          values: { copied: state.report.copied, skipped: state.report.skipped },
        });
      return i18n._({
        id: "Recovered {copied} local records. Skipped {skipped} unreadable items. Original database: {backup}",
        message:
          "Recovered {copied} local records. Skipped {skipped} unreadable items. Original database: {backup}",
        values: state.report,
      });
    case "interrupted":
      return i18n._({
        id: "Database recovery was interrupted. Try recovery again.",
        message: "Database recovery was interrupted. Try recovery again.",
      });
    default:
      return i18n._({
        id: "Rebuild the local database from readable records and re-sync mail. Local drafts and queued changes are kept when readable. The original database and secure tokens are kept.",
        message:
          "Rebuild the local database from readable records and re-sync mail. Local drafts and queued changes are kept when readable. The original database and secure tokens are kept.",
      });
  }
}
const RuntimeContext = createContext<MobileRuntime | null>(null);
const RevisionContext = createContext(0);
export function MailboxProvider({ children }: { children: ReactNode }) {
  const { i18n } = useLingui();
  const [runtime, setRuntime] = useState<MobileRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, setRevision] = useState(0);
  const [databaseState, setDatabaseState] = useState<MobileDatabaseState>({ kind: "healthy" });
  const [recovering, setRecovering] = useState(false);
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const isActive = () => active;
    let instance: MobileRuntime | null = null;
    const initialize = async () => {
      await Promise.resolve();
      if (!isActive()) return;
      try {
        if (attempt > 0) await runRecovery((recovery) => recovery.acknowledge);
        const state = await runRecovery((recovery) => recovery.inspect());
        if (!isActive()) return;
        setDatabaseState(state);
        if (state.kind !== "healthy") return;
        instance = createRuntime(state);
        await instance.runPromise(Mailbox);
        if (isActive()) {
          setRuntime(instance);
          setReady(true);
        }
        const events = Effect.flatMap(Mailbox, (mailbox) =>
          Stream.runForEach(mailbox.app.events, (event) =>
            Effect.sync(() => {
              if (isActive() && (event._tag === "Changed" || event._tag === "PrefsChanged"))
                setRevision((value) => value + 1);
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
  }, [i18n, attempt]);
  const recover = async () => {
    setRecovering(true);
    setRecoveryFailed(false);
    try {
      const report = await runRecovery((recovery) => recovery.rebuild);
      setDatabaseState({ kind: "recovered", report });
    } catch {
      const state = await runRecovery((recovery) => recovery.inspect()).catch(() => null);
      if (state) setDatabaseState(state);
      setRecoveryFailed(true);
    } finally {
      setRecovering(false);
    }
  };
  const acknowledge = () => {
    setDatabaseState({ kind: "healthy" });
    setAttempt((value) => value + 1);
  };
  if (databaseState.kind !== "healthy")
    return (
      <View style={styles.center}>
        <Text accessibilityRole="alert" style={styles.subject}>
          {databaseState.kind === "recovered"
            ? i18n._({
                id: "The local database was recovered",
                message: "The local database was recovered",
              })
            : i18n._({
                id: "The local database could not be verified",
                message: "The local database could not be verified",
              })}
        </Text>
        <Text selectable style={styles.body}>
          {recoveryDetail(databaseState, i18n)}
        </Text>
        {recoveryFailed && (
          <Text accessibilityRole="alert" style={styles.error}>
            {i18n._({
              id: "Could not rebuild the local database",
              message: "Could not rebuild the local database",
            })}
          </Text>
        )}
        {recovering && <ActivityIndicator />}
        <Button
          disabled={recovering}
          label={
            databaseState.kind === "recovered"
              ? i18n._({ id: "Continue", message: "Continue" })
              : i18n._({ id: "Rebuild local database", message: "Rebuild local database" })
          }
          onPress={() => void (databaseState.kind === "recovered" ? acknowledge() : recover())}
        />
      </View>
    );
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
export function useMailboxQuery<A>(
  load: () => Promise<A>,
  options: { keepPrevious?: boolean } = {},
) {
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
  return result?.load === load && (result.revision === revision || options.keepPrevious)
    ? result.state
    : loading;
}
