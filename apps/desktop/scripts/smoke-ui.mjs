/** Re-query and click in one renderer turn. A completed navigation is never clicked again. */
export function smokeClickExpression(selector, ready) {
  return `(() => {
    const ready = ${JSON.stringify(ready ?? null)};
    if (ready && document.querySelector(ready)) return true;
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || !element.isConnected || element.disabled) return false;
    element.click();
    return ready ? !!document.querySelector(ready) : true;
  })()`;
}

export function isBlockedSmokeImage(source, text) {
  return (
    source === "about:srcdoc" &&
    (/^Loading the image '[^\r\n]*' violates the following Content Security Policy directive: "img-src data: cid:"\. The action has been blocked\.$/.test(
      text,
    ) ||
      /^Refused to load the image '[^\r\n]*' because it violates the following Content Security Policy directive: "img-src data: cid:"\.$/.test(
        text,
      ))
  );
}

/**
 * The preview's environment. Offline unless `--network` asks for provider calls: the copied
 * database keeps real accounts and the keychain still has their tokens, so a default run
 * would sync, refresh tokens and fetch contacts against Gmail, Outlook and IMAP servers.
 */
export function smokeEnvironment(base, directory, network = false) {
  const env = {
    ...base,
    OPENMAIL_READ_ONLY: "1",
    OPENMAIL_HOME: directory,
    // Development builds open windows without taking focus from the person's work.
    OPENMAIL_BACKGROUND_WINDOWS: "1",
  };
  if (network) delete env.OPENMAIL_OFFLINE;
  else env.OPENMAIL_OFFLINE = "1";
  return env;
}
