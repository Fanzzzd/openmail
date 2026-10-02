import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { checkStoredUpdates, startAutoUpdates, type UpdateClient } from "./updates.js";

it.effect("manual checks gate network behind packaging, signature and the keychain token", () =>
  Effect.gen(function* () {
    let checks = 0;
    let feeds = 0;
    let verifies = 0;
    let reads = 0;
    let signed = true;
    let token: string | undefined;
    let response: unknown = { isUpdateAvailable: false };
    let fail = false;
    let listeners = 0;
    const client: UpdateClient = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      logger: {},
      setFeedURL: () => {
        feeds++;
      },
      checkForUpdates: () => {
        checks++;
        return fail
          ? Promise.reject(new Error("secret-token-in-error"))
          : Promise.resolve(response);
      },
      on: () => {
        listeners++;
      },
      removeListener: () => {
        listeners--;
      },
    };
    const verify = async () => {
      verifies++;
      return signed;
    };
    const saved = Effect.sync(() => {
      reads++;
      return Option.fromUndefinedOr(token);
    });
    const check = (packaged = true) =>
      checkStoredUpdates(client, { packaged, bundle: "/OpenMail.app" }, saved, verify);
    assert.deepStrictEqual(yield* check(false), { status: "disabled" });
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(yield* check(), { status: "disabled" });
    assert.strictEqual(verifies, 0);
    token = "";
    assert.deepStrictEqual(yield* check(), { status: "disabled" });
    token = "private-token";
    signed = false;
    assert.deepStrictEqual(yield* check(), { status: "disabled" });
    assert.strictEqual(checks, 0);
    assert.strictEqual(feeds, 0);
    signed = true;
    assert.deepStrictEqual(yield* check(), { status: "upToDate" });
    assert.strictEqual(client.logger, null);
    response = { isUpdateAvailable: true, updateInfo: { version: "1.2.3" } };
    assert.deepStrictEqual(yield* check(), { status: "available", version: "1.2.3" });
    response = null;
    assert.deepStrictEqual(yield* check(), { status: "error" });
    fail = true;
    assert.deepStrictEqual(yield* check(), { status: "error" });
    assert.strictEqual(listeners, 0);
  }),
);

it.effect("both update channels retain packaging, signing and authentication gates", () =>
  Effect.gen(function* () {
    let checks = 0,
      feeds = 0;
    const client: UpdateClient = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      logger: null,
      setFeedURL: () => {
        feeds++;
      },
      checkForUpdates: async () => {
        checks++;
        return { isUpdateAvailable: false };
      },
      on: () => null,
      removeListener: () => null,
    };
    for (const channel of ["stable", "latest"] as const) {
      for (const [packaged, signed, token] of [
        [false, true, "token"],
        [true, false, "token"],
        [true, true, ""],
      ] as const) {
        assert.deepStrictEqual(
          yield* checkStoredUpdates(
            client,
            { packaged, bundle: "/OpenMail.app", channel },
            Effect.succeed(Option.some(token)),
            async () => signed,
          ),
          { status: "disabled" },
        );
      }
      assert.strictEqual(checks, channel === "stable" ? 0 : 1);
      assert.strictEqual(feeds, checks);
      yield* checkStoredUpdates(
        client,
        { packaged: true, bundle: "/OpenMail.app", channel },
        Effect.succeed(Option.some("token")),
        async () => true,
      );
      assert.strictEqual(client.allowPrerelease, channel === "latest");
    }
    assert.strictEqual(checks, 2);
  }),
);

it("automatic channel selection changes release eligibility only after all three gates pass", () => {
  let checks = 0,
    feeds = 0;
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => {
      feeds++;
    },
    checkForUpdates: async () => {
      checks++;
    },
    on: () => null,
    removeListener: () => null,
  };
  for (const channel of ["stable", "latest"] as const) {
    for (const [packaged, signed, token] of [
      [false, true, "token"],
      [true, false, "token"],
      [true, true, ""],
    ] as const)
      startAutoUpdates(client, { packaged, signed, token, channel })();
    assert.strictEqual(checks, channel === "stable" ? 0 : 1);
    const stop = startAutoUpdates(client, {
      packaged: true,
      signed: true,
      token: "token",
      channel,
    });
    assert.strictEqual(client.allowPrerelease, channel === "latest");
    assert.strictEqual(client.autoDownload, true);
    stop();
    assert.strictEqual(client.autoDownload, false);
  }
  assert.strictEqual(checks, 2);
  assert.strictEqual(feeds, 2);
});

it("switching to Stable keeps a staged prerelease from being installed on quit", async () => {
  let resolveStable: (value: unknown) => void = () => null;
  const stable = new Promise<unknown>((resolve) => {
    resolveStable = resolve;
  });
  let checks = 0;
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => null,
    checkForUpdates: () =>
      ++checks === 1
        ? Promise.resolve({
            isUpdateAvailable: true,
            updateInfo: { version: "2.0.0-beta.1" },
            downloadPromise: Promise.resolve([]),
          })
        : stable,
    on: () => null,
    removeListener: () => null,
  };
  const stopLatest = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    token: "test",
    channel: "latest",
  });
  await Promise.resolve();
  await Promise.resolve();
  stopLatest();
  const stopStable = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    token: "test",
    channel: "stable",
  });
  try {
    assert.strictEqual(client.autoInstallOnAppQuit, false);
    resolveStable({ isUpdateAvailable: false });
    await stable;
    await Promise.resolve();
    assert.strictEqual(client.autoInstallOnAppQuit, false);
  } finally {
    stopStable();
  }
});

it("late downloads from Latest cannot unlock Stable; a completed Stable download also remains deferred", async () => {
  let finishLatest: () => void = () => null,
    finishStable: () => void = () => null;
  const latestDownload = new Promise<void>((resolve) => {
    finishLatest = resolve;
  });
  const stableDownload = new Promise<void>((resolve) => {
    finishStable = resolve;
  });
  let checks = 0;
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => null,
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: ++checks === 1 ? "2.0.0-beta.1" : "2.0.0" },
      downloadPromise: checks === 1 ? latestDownload : stableDownload,
    }),
    on: () => null,
    removeListener: () => null,
  };
  const stopLatest = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    token: "fixture",
    channel: "latest",
  });
  await Promise.resolve();
  stopLatest();
  const stopStable = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    token: "fixture",
    channel: "stable",
  });
  try {
    finishLatest();
    await latestDownload;
    await Promise.resolve();
    assert.strictEqual(client.autoInstallOnAppQuit, false);
    finishStable();
    await stableDownload;
    await Promise.resolve();
    assert.strictEqual(client.autoInstallOnAppQuit, false);
  } finally {
    stopStable();
  }
});

it("downloads never automatically hand a package to the native updater", async () => {
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => null,
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "2.0.0-beta.1" },
      downloadPromise: Promise.resolve([]),
    }),
    on: () => null,
    removeListener: () => null,
  };
  const stop = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    token: "fixture",
    channel: "latest",
  });
  try {
    assert.strictEqual(client.autoInstallOnAppQuit, false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(client.autoInstallOnAppQuit, false);
  } finally {
    stop();
  }
});
