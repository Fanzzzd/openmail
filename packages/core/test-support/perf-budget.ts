/**
 * OPENMAIL_PERF_FACTOR scales the wall-clock budgets of `pnpm test:perf`. It is 1 locally;
 * the scheduled CI job on shared runners sets a looser factor (docs/performance.md).
 */
export const PERF_FACTOR = (() => {
  const value = Number(process.env.OPENMAIL_PERF_FACTOR ?? "1");
  return Number.isFinite(value) && value >= 1 ? value : 1;
})();

export const perfBudget = (ms: number) => ms * PERF_FACTOR;
