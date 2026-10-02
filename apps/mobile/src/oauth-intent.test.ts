import { expect, it, vi } from "vitest";
import type { MobileConfig } from "./platform/config";
import { oauthSystemPath } from "./oauth-intent";

const config: MobileConfig = {
  googleIosClientId: "ios.apps.googleusercontent.com",
  googleAndroidClientId: "android.apps.googleusercontent.com",
  microsoftClientId: "my-client",
  microsoftIosRedirect: "msauth.com.example.mail://auth",
  microsoftAndroidRedirect: "msauth://com.example.mail/abc%2Bdef%2Fghi%3D",
};
vi.mock("./platform/config", () => ({ readMobileConfig: () => config }));

it("routes registered OAuth callbacks to accounts without handing codes to the router", () => {
  for (const callback of [
    "com.googleusercontent.apps.ios:/oauthredirect?code=secret&state=state",
    "com.googleusercontent.apps.android:/oauthredirect?error=access_denied",
    "msauth.com.example.mail://auth?code=secret&state=state",
    "msauth://com.example.mail/abc%2Bdef%2Fghi%3D?code=secret",
  ]) {
    expect(oauthSystemPath(callback, config)).toBe("/");
  }
  expect(oauthSystemPath("msauth://another.app/other?code=secret", config)).toBe(
    "msauth://another.app/other?code=secret",
  );
  expect(oauthSystemPath("openmail://reader?messageId=one", config)).toBe(
    "openmail://reader?messageId=one",
  );
  expect(oauthSystemPath("malformed-url", config)).toBe("/");
});
it("wires expo-router native-intent redirects for cold and warm callbacks", async () => {
  const { redirectSystemPath } = await import("../app/+native-intent");
  expect(
    redirectSystemPath({ path: `${config.microsoftIosRedirect}?code=secret`, initial: true }),
  ).toBe("/");
  expect(
    redirectSystemPath({ path: `${config.microsoftAndroidRedirect}?code=secret`, initial: false }),
  ).toBe("/");
});
