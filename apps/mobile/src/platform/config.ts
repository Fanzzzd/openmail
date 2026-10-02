import { AppConfig, type ClientConfig } from "@openmail/core/portable";
import { Effect, Layer, Schema } from "effect";
import Constants from "expo-constants";
import { Platform } from "react-native";

export const MobileConfigSchema = Schema.Struct({
  googleIosClientId: Schema.String,
  googleAndroidClientId: Schema.String,
  microsoftClientId: Schema.String,
  microsoftIosRedirect: Schema.String,
  microsoftAndroidRedirect: Schema.String,
});
export type MobileConfig = typeof MobileConfigSchema.Type;
export const readMobileConfig = () =>
  Schema.decodeUnknownSync(MobileConfigSchema)(Constants.expoConfig?.extra?.mobileOAuth);
export function clientConfig(config: MobileConfig, os: string): ClientConfig {
  const googleId = os === "ios" ? config.googleIosClientId : config.googleAndroidClientId;
  return {
    ...(googleId ? { google: { clientId: googleId, clientSecret: "" } } : {}),
    ...(config.microsoftClientId ? { microsoft: { clientId: config.microsoftClientId } } : {}),
  };
}
export const configLayer = (config: MobileConfig) =>
  Layer.succeed(AppConfig, {
    read: Effect.succeed(clientConfig(config, Platform.OS)),
    write: () => Effect.die(new Error("Register mobile clients in app config and rebuild")),
  });
