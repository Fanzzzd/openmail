import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Crypto, Effect, Option } from "effect";
import { Secrets, MODEL_KEY } from "@openmail/core/portable";

const native = vi.hoisted(() => ({
  vault: new Map<string, string>(),
  os: "ios",
  cancelled: false,
  mismatched: false,
  requests: [] as Record<string, unknown>[],
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active" },
  Platform: {
    get OS() {
      return native.os;
    },
  },
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "after-first-unlock-device-only",
  getItemAsync: async (key: string, options: unknown) => {
    native.get(key, options);
    return native.vault.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string, options: unknown) => {
    native.set(key, value, options);
    native.vault.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    native.remove(key);
    native.vault.delete(key);
  },
}));
vi.mock("expo-crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
  getRandomBytes: (size: number) => new Uint8Array(size).fill(7),
  CryptoDigestAlgorithm: { SHA1: "sha1", SHA256: "sha256", SHA384: "sha384", SHA512: "sha512" },
  digest: async (algorithm: string, bytes: Uint8Array) =>
    new Uint8Array(createHash(algorithm).update(bytes).digest()).buffer,
}));
vi.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: vi.fn(),
  openBrowserAsync: vi.fn(),
}));
vi.mock("expo-auth-session", () => ({
  CodeChallengeMethod: { S256: "S256" },
  ResponseType: { Code: "code" },
  makeRedirectUri: ({ native }: { native: string }) => native,
  AuthRequest: class {
    state = "secure-state";
    codeVerifier = "secure-verifier";
    constructor(request: Record<string, unknown>) {
      native.requests.push(request);
    }
    async makeAuthUrlAsync() {
      return "https://example.test";
    }
    async promptAsync() {
      return native.cancelled
        ? { type: "cancel" }
        : {
            type: "success",
            params: { code: "one-time-code", state: native.mismatched ? "wrong" : this.state },
          };
    }
  },
}));

import { secretsLayer, secretKey } from "./secrets";
import { cryptoLayer } from "./crypto";
import { clientConfig, type MobileConfig } from "./config";
import { authSession, googleRedirect } from "./oauth";

const config: MobileConfig = {
  googleIosClientId: "ios-123.apps.googleusercontent.com",
  googleAndroidClientId: "android-456.apps.googleusercontent.com",
  microsoftClientId: "my-public-client",
  microsoftIosRedirect: "msauth.com.openmail.mobile://auth",
  microsoftAndroidRedirect: "msauth://com.openmail.mobile/signature",
};

describe("Expo platform services with native mocks", () => {
  it("stores the Anthropic API key in device-only SecureStore and removes it on request", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        yield* secrets.set(MODEL_KEY, "anthropic-private");
        expect(native.vault.get(secretKey(MODEL_KEY))).toBe("anthropic-private");
        expect(Option.getOrNull(yield* secrets.get(MODEL_KEY))).toBe("anthropic-private");
        yield* secrets.remove(MODEL_KEY);
        expect(Option.isNone(yield* secrets.get(MODEL_KEY))).toBe(true);
      }).pipe(Effect.provide(secretsLayer)),
    );
    expect(native.set).toHaveBeenCalledWith(secretKey(MODEL_KEY), "anthropic-private", {
      keychainService: "openmail.refresh-tokens",
      keychainAccessible: "after-first-unlock-device-only",
    });
  });
  it("round-trips refresh tokens exclusively through device-only SecureStore", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* Secrets;
        expect(Option.isNone(yield* secrets.get("gmail:person@example.test"))).toBe(true);
        yield* secrets.set("gmail:person@example.test", "refresh-private");
        expect(Option.getOrNull(yield* secrets.get("gmail:person@example.test"))).toBe(
          "refresh-private",
        );
        yield* secrets.remove("gmail:person@example.test");
        expect(Option.isNone(yield* secrets.get("gmail:person@example.test"))).toBe(true);
      }).pipe(Effect.provide(secretsLayer)),
    );
    expect(native.set).toHaveBeenCalledWith(
      secretKey("gmail:person@example.test"),
      "refresh-private",
      {
        keychainService: "openmail.refresh-tokens",
        keychainAccessible: "after-first-unlock-device-only",
      },
    );
    expect(secretKey("a:b")).not.toBe(secretKey("a_b"));
    expect(secretKey("person@example.test")).toMatch(/^[\w.-]+$/);
  });

  it("uses native randomness and digest bytes for Effect Crypto", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        expect(yield* crypto.randomBytes(4)).toEqual(new Uint8Array([7, 7, 7, 7]));
        expect(yield* crypto.digest("SHA-256", new TextEncoder().encode("mobile"))).toEqual(
          new Uint8Array(createHash("sha256").update("mobile").digest()),
        );
      }).pipe(Effect.provide(cryptoLayer)),
    );
  });

  it("selects separate registered clients and never supplies a mobile client secret", () => {
    expect(clientConfig(config, "ios").google).toEqual({
      clientId: config.googleIosClientId,
      clientSecret: "",
    });
    expect(clientConfig(config, "android").google?.clientId).toBe(config.googleAndroidClientId);
    expect(
      clientConfig({ ...config, googleIosClientId: "", microsoftClientId: "" }, "ios"),
    ).toEqual({});
  });

  it("wires system browser authorization to PKCE, state, and the registered native redirects", async () => {
    native.os = "ios";
    const request = {
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      clientId: config.googleIosClientId,
      scopes: ["email"],
      clientSecret: "",
    };
    const result = await authSession(config).authorize(request);
    expect(result).toEqual({
      code: "one-time-code",
      verifier: "secure-verifier",
      redirectUri: googleRedirect(config.googleIosClientId),
    });
    expect(native.requests.at(-1)).toMatchObject({
      usePKCE: true,
      codeChallengeMethod: "S256",
      responseType: "code",
    });
    native.os = "android";
    const android = await authSession(config).authorize({
      ...request,
      clientId: config.googleAndroidClientId,
    });
    expect(android?.redirectUri).toBe(googleRedirect(config.googleAndroidClientId));
    const microsoft = await authSession(config).authorize({
      ...request,
      authUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
      clientId: config.microsoftClientId,
    });
    expect(microsoft?.redirectUri).toBe(config.microsoftAndroidRedirect);
    await expect(
      authSession(config).authorize({ ...request, clientId: "borrowed-client" }),
    ).rejects.toThrow("registered public client");
    await expect(
      authSession(config).authorize({
        ...request,
        authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      }),
    ).rejects.toThrow("Unsupported");
    native.os = "ios";
    native.cancelled = true;
    await expect(authSession(config).authorize(request)).resolves.toBeNull();
    native.cancelled = false;
    native.mismatched = true;
    await expect(authSession(config).authorize(request)).rejects.toThrow("Invalid authorization");
    native.mismatched = false;
  });
});

it("returns a typed, redacted error for locked SecureStore reads, then succeeds after unlock", async () => {
  const key = "gmail:locked@example.test";
  native.vault.set(secretKey(key), "stored-refresh-private");
  native.get.mockImplementationOnce(() => {
    throw new Error("Device locked; stored-refresh-private");
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const secrets = yield* Secrets;
      const locked = yield* secrets.get(key).pipe(Effect.result);
      expect(locked._tag).toBe("Failure");
      if (locked._tag === "Failure") {
        expect(locked.failure._tag).toBe("ProviderError");
        expect(locked.failure.message).toContain("unlock the device");
        expect(locked.failure.message).not.toContain("stored-refresh-private");
      }
      expect(Option.getOrNull(yield* secrets.get(key))).toBe("stored-refresh-private");
    }).pipe(Effect.provide(secretsLayer)),
  );
});
