/**
 * Lazy dialogs import their module on first open. Under load that import can take seconds with
 * no DOM change or RPC, and eventually() would read the wait as a stall. setup.ts starts each
 * import when its dialog is declared and records it here; flow() waits for all of them.
 */
export const lazyLoads: Promise<unknown>[] = [];
