import { Browser, type MobileAuthSession } from "@openmail/core/portable";
import { Effect, Layer } from "effect";
import { AuthRequest, CodeChallengeMethod, ResponseType, makeRedirectUri } from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";
import type { MobileConfig } from "./config";

WebBrowser.maybeCompleteAuthSession();

export function googleRedirect(clientId: string): string {
  if (!/^[-a-zA-Z0-9]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error("Register a Google iOS or Android OAuth client");
  }
  return `${clientId.split(".").toReversed().join(".")}:/oauthredirect`;
}
export const authSession = (config: MobileConfig): MobileAuthSession => ({
  authorize: async (request) => {
    const google = request.authUrl === "https://accounts.google.com/o/oauth2/v2/auth";
    if (
      !google &&
      request.authUrl !== "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize"
    ) {
      throw new Error("Unsupported mobile authorization endpoint");
    }
    const expectedId = google
      ? Platform.OS === "ios"
        ? config.googleIosClientId
        : config.googleAndroidClientId
      : config.microsoftClientId;
    if (!expectedId || request.clientId !== expectedId || request.clientSecret) {
      throw new Error("Mobile authorization requires your registered public client");
    }
    const native = google
      ? googleRedirect(expectedId)
      : Platform.OS === "ios"
        ? config.microsoftIosRedirect
        : config.microsoftAndroidRedirect;
    if (!native || !/^[a-z][a-z0-9.+-]*:/i.test(native) || /^https?:/i.test(native)) {
      throw new Error("Configure the registered native redirect URI");
    }
    const redirectUri = makeRedirectUri({ native });
    const auth = new AuthRequest({
      clientId: expectedId,
      redirectUri,
      scopes: [...request.scopes],
      responseType: ResponseType.Code,
      usePKCE: true,
      codeChallengeMethod: CodeChallengeMethod.S256,
      extraParams: request.extraParams,
    });
    const discovery = { authorizationEndpoint: request.authUrl, tokenEndpoint: request.tokenUrl };
    await auth.makeAuthUrlAsync(discovery);
    const response = await auth.promptAsync(discovery);
    if (
      response.type !== "success" ||
      response.params.state !== auth.state ||
      !response.params.code ||
      !auth.codeVerifier
    ) {
      throw new Error("Sign-in cancelled or invalid authorization response");
    }
    return { code: response.params.code, verifier: auth.codeVerifier, redirectUri };
  },
});
export const browserLayer = Layer.succeed(Browser, {
  open: (url) =>
    Effect.tryPromise(() => WebBrowser.openBrowserAsync(url)).pipe(Effect.asVoid, Effect.orDie),
});
