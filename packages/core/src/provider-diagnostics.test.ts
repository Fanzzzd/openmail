import { Effect, Logger } from "effect";
import { HttpClientRequest } from "effect/http";
import { expect, it } from "vitest";
import {
  logProviderFailure,
  logInvalidGraphCursor,
  providerEndpoint,
  makeOptionalPermissions,
} from "./provider-diagnostics.js";
import { diagnosticRecord } from "./platform/node/diagnostics.js";

it("provider diagnostics contain templates and hashes without ids, bodies or tokens", () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) => {
    records.push(...(Array.isArray(options.message) ? options.message : [options.message]));
  });
  Effect.runSync(
    logProviderFailure(
      "outlook",
      "private@example.com",
      HttpClientRequest.get(
        "https://graph.microsoft.com/v1.0/me/messages/private-id?$select=secret",
      ),
      { status: 403 },
    ).pipe(Effect.provide(Logger.layer([logger]))),
  );
  const record = diagnosticRecord("provider-failure", records[0], 0);
  expect(record).toMatchObject({
    event: "provider-failure",
    provider: "outlook",
    method: "GET",
    endpoint: "/me/messages/:id",
    status: 403,
    accountHash: expect.stringMatching(/^[a-f0-9]{16}$/),
  });
  expect(JSON.stringify(record)).not.toMatch(/private|secret|example/);
  expect(diagnosticRecord("provider-failure", record, 0)).toEqual(record);
  expect(
    providerEndpoint("https://graph.microsoft.com/v1.0/me/mailFolders/id/messageRules/rule-id"),
  ).toBe("/me/mailFolders/:id/messageRules");
  expect(providerEndpoint("https://graph.microsoft.com/v1.0/me/mailboxSettings?token=secret")).toBe(
    "/me/mailboxSettings",
  );
  expect(providerEndpoint("https://example.com/private")).toBe("/other");
});

it("optional denials stop network attempts until reauthentication, without caching quota failures", async () => {
  const gate = makeOptionalPermissions<{ _tag: "ApiError"; status: number; body: string }>();
  const request = HttpClientRequest.get("https://graph.microsoft.com/v1.0/me/mailboxSettings");
  let attempts = 0;
  const denied = Effect.suspend(() => {
    attempts++;
    return Effect.fail({ _tag: "ApiError" as const, status: 403, body: "" });
  });
  for (let i = 0; i < 3; i++)
    await Effect.runPromise(gate.run("a", request, denied).pipe(Effect.result));
  expect(attempts).toBe(1);
  gate.clear();
  await Effect.runPromise(gate.run("a", request, denied).pipe(Effect.result));
  expect(attempts).toBe(2);
  const quota = Effect.fail({ _tag: "ApiError" as const, status: 403, body: "rateLimitExceeded" });
  for (let i = 0; i < 2; i++)
    await Effect.runPromise(gate.run("other", request, quota).pipe(Effect.result));
  expect(await Effect.runPromise(gate.run("other", request, Effect.succeed("allowed")))).toBe(
    "allowed",
  );
});

it("RPC failure diagnostics retain only the method name across storage and preview", () => {
  const record = diagnosticRecord(
    "rpc-failure",
    {
      rpc: "ReaderAttachments",
      payload: "private text",
      account: "private@example.com",
      token: "private-token",
      code: 403,
    },
    0,
  );
  expect(record).toEqual({ at: 0, event: "rpc-failure", rpc: "ReaderAttachments" });
  expect(diagnosticRecord("rpc-failure", record, 0)).toEqual(record);
  expect(diagnosticRecord("rpc-failure", { rpc: "GET /private?token=secret" }, 0)).toEqual({
    at: 0,
    event: "rpc-failure",
  });
});

it("status zero means an actual transport failure; credentials and configuration have no HTTP status", () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) =>
    records.push(...(Array.isArray(options.message) ? options.message : [options.message])),
  );
  for (const error of [
    { _tag: "ApiError", status: 0 },
    { _tag: "AuthError" },
    { _tag: "ProviderError", reason: "configuration" },
  ]) {
    Effect.runSync(
      logProviderFailure(
        "outlook",
        "fake",
        HttpClientRequest.get("https://graph.microsoft.com/v1.0/me/messages/fake"),
        error,
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
  }
  expect(diagnosticRecord("provider-failure", records[0], 0)).toMatchObject({
    failure: "transport",
    status: 0,
  });
  expect(diagnosticRecord("provider-failure", records[1], 0)).toMatchObject({
    failure: "credentials",
  });
  expect(diagnosticRecord("provider-failure", records[2], 0)).toMatchObject({
    failure: "configuration",
  });
  for (const record of records.slice(1))
    expect(diagnosticRecord("provider-failure", record, 0)).not.toHaveProperty("status");
});

it("sync crash reasons survive export and exclude free text", () => {
  const record = diagnosticRecord(
    "runtime-error",
    {
      _tag: "SyncCrashDiagnostic",
      reason: "sync-crashed",
      phase: "verification",
      causeKind: "defect",
      message: "private message",
      cause: new Error("private token"),
      stack: "private stack",
    },
    0,
  );
  expect(record).toEqual({
    at: 0,
    event: "runtime-error",
    reason: "sync-crashed",
    phase: "verification",
    causeKind: "defect",
  });
  expect(diagnosticRecord("runtime-error", record, 0)).toEqual(record);
  expect(
    JSON.stringify(
      diagnosticRecord(
        "runtime-error",
        { reason: "sync-crashed", phase: "private", causeKind: "private" },
        0,
      ),
    ),
  ).not.toContain("private");
});

it("deferred attempts do not emit provider failures", () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) => records.push(options.message));
  Effect.runSync(
    logProviderFailure(
      "outlook",
      "account",
      HttpClientRequest.get("https://graph.microsoft.com/v1.0/me/messages"),
      { _tag: "ProviderError", status: 0, deferred: true },
    ).pipe(Effect.provide(Logger.layer([logger]))),
  );
  expect(records).toEqual([]);
});

it("Graph search codes survive export but unknown strings and content do not", async () => {
  const { graphSearchErrorCode } = await import("./provider-diagnostics.js");
  const records: unknown[] = [];
  const logger = Logger.make((options) =>
    records.push(...(Array.isArray(options.message) ? options.message : [options.message])),
  );
  for (const code of ["ErrorInvalidProperty", "private-token-error"])
    Effect.runSync(
      logProviderFailure(
        "outlook",
        "account",
        HttpClientRequest.get("https://graph.microsoft.com/v1.0/me/messages?$search=private"),
        { status: 400 },
        {
          operation: "search",
          errorCode: graphSearchErrorCode(
            JSON.stringify({ error: { code, message: "private message" } }),
          ),
        },
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
  const exported = records.map((record) => diagnosticRecord("provider-failure", record, 0));
  expect(exported).toMatchObject([
    { operation: "search", errorCode: "ErrorInvalidProperty" },
    { operation: "search", errorCode: "unknown" },
  ]);
  expect(JSON.stringify(exported)).not.toContain("private");
});

it("invalid cursor diagnostics retain a fixed code and account hash without cursor data", () => {
  const records: unknown[] = [];
  const logger = Logger.make((options) => {
    records.push(...(Array.isArray(options.message) ? options.message : [options.message]));
  });
  Effect.runSync(
    logInvalidGraphCursor("private@example.test").pipe(Effect.provide(Logger.layer([logger]))),
  );
  const record = diagnosticRecord("provider-failure", records[0], 0);
  expect(record).toMatchObject({
    operation: "delta",
    errorCode: "InvalidDeltaCursor",
    accountHash: expect.stringMatching(/^[a-f0-9]{16}$/),
  });
  expect(JSON.stringify(record)).not.toMatch(/private|example|token|skiptoken/);
  expect(diagnosticRecord("provider-failure", record, 0)).toEqual(record);
});
