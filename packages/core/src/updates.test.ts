import { assert, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { checkStoredUpdates, type UpdateClient } from "./updates.js";

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
