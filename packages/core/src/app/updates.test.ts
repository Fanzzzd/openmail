import { vi } from "vitest";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkVerifiedUpdates, startAutoUpdates, type UpdateClient } from "./updates.js";

it.effect(
  "manual checks gate network behind packaging and signature, then read the public feed",
  () =>
    Effect.gen(function* () {
      let checks = 0;
      let feeds = 0;
      let verifies = 0;
      let signed = true;
      const feedOptions: unknown[] = [];
      let response: unknown = { isUpdateAvailable: false };
      let fail = false;
      let listeners = 0;
      const client: UpdateClient = {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        logger: {},
        setFeedURL: (options) => {
          feeds++;
          feedOptions.push(options);
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
      const check = (packaged = true) =>
        checkVerifiedUpdates(client, { packaged, bundle: "/OpenMail.app" }, verify);
      assert.deepStrictEqual(yield* check(false), { status: "disabled" });
      assert.strictEqual(verifies, 0);
      signed = false;
      assert.deepStrictEqual(yield* check(), { status: "disabled" });
      assert.strictEqual(checks, 0);
      assert.strictEqual(feeds, 0);
      signed = true;
      assert.deepStrictEqual(yield* check(), { status: "upToDate" });
      assert.strictEqual(client.logger, null);
      assert.deepStrictEqual(feedOptions, [
        { provider: "github", owner: "Fanzzzd", repo: "openmail" },
      ]);
      response = { isUpdateAvailable: true, updateInfo: { version: "1.2.3" } };
      assert.deepStrictEqual(yield* check(), { status: "available", version: "1.2.3" });
      response = null;
      assert.deepStrictEqual(yield* check(), { status: "error" });
      fail = true;
      assert.deepStrictEqual(yield* check(), { status: "error" });
      assert.strictEqual(listeners, 0);
    }),
);

it.effect("both update channels retain packaging and signing gates", () =>
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
      for (const [packaged, signed] of [
        [false, true],
        [true, false],
      ] as const) {
        assert.deepStrictEqual(
          yield* checkVerifiedUpdates(
            client,
            { packaged, bundle: "/OpenMail.app", channel },
            async () => signed,
          ),
          { status: "disabled" },
        );
      }
      assert.strictEqual(checks, channel === "stable" ? 0 : 1);
      assert.strictEqual(feeds, checks);
      yield* checkVerifiedUpdates(
        client,
        { packaged: true, bundle: "/OpenMail.app", channel },
        async () => true,
      );
      assert.strictEqual(client.allowPrerelease, channel === "latest");
    }
    assert.strictEqual(checks, 2);
  }),
);

it("automatic channel selection changes release eligibility only after both gates pass", () => {
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
    for (const [packaged, signed] of [
      [false, true],
      [true, false],
    ] as const)
      startAutoUpdates(client, { packaged, signed, channel })();
    assert.strictEqual(checks, channel === "stable" ? 0 : 1);
    const stop = startAutoUpdates(client, {
      packaged: true,
      signed: true,
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
    channel: "latest",
  });
  await Promise.resolve();
  await Promise.resolve();
  stopLatest();
  const stopStable = startAutoUpdates(client, {
    packaged: true,
    signed: true,
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
    channel: "latest",
  });
  await Promise.resolve();
  stopLatest();
  const stopStable = startAutoUpdates(client, {
    packaged: true,
    signed: true,
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

it("background update status follows availability/downloads, honors opt-out and suppresses stopped callbacks", async () => {
  const states: import("./update-state.js").UpdateState[] = [];
  let finish: () => void = () => null;
  let fail: (error: Error) => void = () => null;
  let download = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => null,
    on: () => null,
    removeListener: () => null,
    checkForUpdates: async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "2.0.0" },
      ...(client.autoDownload ? { downloadPromise: download } : {}),
    }),
  };
  const flush = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  const start = (autoDownload: boolean) =>
    startAutoUpdates(client, {
      packaged: true,
      signed: true,
      autoDownload,
      onState: (state) => states.push(state),
    });
  const off = start(false);
  await flush();
  assert.deepStrictEqual(states, [
    { status: "checking" },
    { status: "available", version: "2.0.0" },
  ]);
  assert.strictEqual(client.autoDownload, false);
  off();
  states.length = 0;
  const on = start(true);
  await flush();
  assert.deepStrictEqual(states, [
    { status: "checking" },
    { status: "available", version: "2.0.0" },
    { status: "downloading", version: "2.0.0" },
  ]);
  finish();
  await flush();
  assert.deepStrictEqual(states.at(-1), { status: "downloaded", version: "2.0.0" });
  assert.strictEqual(client.autoInstallOnAppQuit, false);
  on();
  states.length = 0;
  download = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const stopped = start(true);
  await flush();
  stopped();
  const before = [...states];
  finish();
  await flush();
  assert.deepStrictEqual(states, before);
  states.length = 0;
  download = new Promise<void>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const failed = start(true);
  await flush();
  fail(new Error("https://release-secret@release.example/signed-url"));
  await flush();
  assert.deepStrictEqual(states.at(-1), { status: "error" });
  assert.ok(!JSON.stringify(states).includes("release-secret"));
  failed();
});

it.effect(
  "manual download obeys packaging and signature gates and rejects an ineligible Stable version",
  () =>
    Effect.gen(function* () {
      const states: import("./update-state.js").UpdateState[] = [];
      let checks = 0;
      const client: UpdateClient = {
        autoDownload: false,
        autoInstallOnAppQuit: false,
        logger: null,
        setFeedURL: () => null,
        on: () => null,
        removeListener: () => null,
        checkForUpdates: async () => {
          checks++;
          return { isUpdateAvailable: true, updateInfo: { version: "2.0.0-beta.1" } };
        },
      };
      yield* checkVerifiedUpdates(
        client,
        {
          packaged: false,
          bundle: "/OpenMail.app",
          autoDownload: true,
          onState: (state) => states.push(state),
        },
        async () => true,
      );
      const options = {
        packaged: true,
        bundle: "/OpenMail.app",
        autoDownload: true,
        onState: (state: import("./update-state.js").UpdateState) => states.push(state),
      };
      assert.deepStrictEqual(states, [{ status: "disabled" }]);
      assert.strictEqual(client.autoDownload, false);
      yield* checkVerifiedUpdates(client, options, async () => false);
      assert.strictEqual(checks, 0);
      assert.strictEqual(client.autoDownload, false);
      assert.deepStrictEqual(yield* checkVerifiedUpdates(client, options, async () => true), {
        status: "error",
      });
      assert.deepStrictEqual(states.at(-1), { status: "error" });
      assert.strictEqual(client.autoInstallOnAppQuit, false);
    }),
);

it("manual download restores automatic opt-out before the next timer check, including failures", async () => {
  vi.useFakeTimers();
  const observed: boolean[] = [];
  let fail = false;
  const client: UpdateClient = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: () => null,
    on: () => null,
    removeListener: () => null,
    checkForUpdates: async () => {
      observed.push(client.autoDownload);
      if (fail) throw new Error("download check failed");
      return { isUpdateAvailable: false };
    },
  };
  const stop = startAutoUpdates(client, {
    packaged: true,
    signed: true,
    autoDownload: false,
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    await Effect.runPromise(
      checkVerifiedUpdates(
        client,
        { packaged: true, bundle: "/OpenMail.app", autoDownload: true },
        async () => true,
      ),
    );
    assert.strictEqual(client.autoDownload, false);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    assert.deepStrictEqual(observed, [false, true, false]);
    fail = true;
    await Effect.runPromise(
      checkVerifiedUpdates(
        client,
        { packaged: true, bundle: "/OpenMail.app", autoDownload: true },
        async () => true,
      ),
    );
    assert.strictEqual(client.autoDownload, false);
  } finally {
    stop();
    vi.useRealTimers();
  }
});
