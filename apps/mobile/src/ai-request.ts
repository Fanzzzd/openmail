import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { Mailbox, type AiEvent, type PerformError } from "@openmail/core/portable";
import { Effect, type Stream } from "effect";
import { aiResponse } from "./ai-workflows";
import { useMailbox, useMailboxQuery } from "./mailbox";

type Response =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ready"; text: string }
  | { kind: "failed" };
export function useAiRequest(accountId: string) {
  const runtime = useMailbox();
  const settings = useMailboxQuery(
    useCallback(
      () => runtime.runPromise(Effect.flatMap(Mailbox, (mailbox) => mailbox.ai.aiSettings)),
      [runtime],
    ),
    { keepPrevious: true },
  );
  const account =
    settings.kind === "ready"
      ? settings.value.accounts.find((entry) => entry.accountId === accountId)
      : undefined;
  const enabled =
    settings.kind === "ready" && settings.value.keyConfigured && account?.allowed === true;
  const identity = `${accountId}:${enabled}:${settings.kind === "ready" ? settings.value.model : "loading"}`;
  const [result, setResult] = useState<{ identity: string; response: Response } | null>(null);
  const controller = useRef<{ identity: string; abort: AbortController } | null>(null);
  const cancel = useCallback(() => {
    controller.current?.abort.abort();
    controller.current = null;
    setResult(null);
  }, []);
  useEffect(() => {
    if (controller.current?.identity !== identity) {
      controller.current?.abort.abort();
      controller.current = null;
    }
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") cancel();
    });
    return () => {
      controller.current?.abort.abort();
      controller.current = null;
      subscription.remove();
    };
  }, [identity, cancel]);
  const run = useCallback(
    async (request: (mailbox: Mailbox["Service"]) => Stream.Stream<AiEvent, PerformError>) => {
      if (!enabled || controller.current || AppState.currentState !== "active") return;
      const pending = { identity, abort: new AbortController() };
      controller.current = pending;
      setResult({ identity, response: { kind: "busy" } });
      try {
        const text = await runtime.runPromise(
          Effect.flatMap(Mailbox, (mailbox) => aiResponse(request(mailbox))),
          { signal: pending.abort.signal },
        );
        if (controller.current === pending)
          setResult({ identity, response: { kind: "ready", text } });
      } catch {
        if (controller.current === pending) setResult({ identity, response: { kind: "failed" } });
      } finally {
        if (controller.current === pending) controller.current = null;
      }
    },
    [runtime, enabled, identity],
  );
  const response: Response = result?.identity === identity ? result.response : { kind: "idle" };
  return { settings, account, enabled, response, run, cancel };
}
