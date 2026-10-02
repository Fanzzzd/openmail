import type { MobileConfig } from "./platform/config";

/** Router routing must not consume codes; AuthSession's separate listener validates state and PKCE. */
export function oauthSystemPath(path: string, config: MobileConfig): string {
  try {
    const incoming = new URL(path);
    const google = [config.googleIosClientId, config.googleAndroidClientId]
      .filter(Boolean)
      .map((id) => `${id.split(".").toReversed().join(".")}:/oauthredirect`);
    const redirects = [
      ...google,
      config.microsoftIosRedirect,
      config.microsoftAndroidRedirect,
    ].filter(Boolean);
    if (
      redirects.some((redirect) => {
        const registered = new URL(redirect);
        return (
          incoming.protocol === registered.protocol &&
          incoming.host === registered.host &&
          decodeURIComponent(incoming.pathname) === decodeURIComponent(registered.pathname)
        );
      })
    )
      return "/";
    return path;
  } catch {
    return "/";
  }
}
