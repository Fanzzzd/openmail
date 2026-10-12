let relaunch: (() => Promise<boolean>) | undefined;
export function setRecoveryRelaunch(handler: () => Promise<boolean>) {
  relaunch = handler;
  return () => {
    if (relaunch === handler) relaunch = undefined;
  };
}
/** Recovery must use the same pending-send guard as normal Quit. */
export const requestRecoveryRelaunch = () => relaunch?.() ?? Promise.resolve(false);
