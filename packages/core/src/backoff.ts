/** A retry runs up to this share of its delay early, so clients that failed together spread out. */
export const JITTER = 0.2;

/** `delay` shortened by up to JITTER; `random` is in [0, 1). */
export const jittered = (delay: number, random: number) =>
  Math.round(delay * (1 - random * JITTER));
