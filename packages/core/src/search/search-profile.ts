import { Context, Effect } from "effect";

/** Optional profiling port. Clocks and captured reports belong to the platform harness. */
export interface SearchProfiler {
  readonly begin: (step: string) => () => void;
}
export const SearchProfile = Context.Reference<SearchProfiler | null>("openmail/SearchProfile", {
  defaultValue: () => null,
});

export function searchStep<A>(profile: SearchProfiler | null, step: string, run: () => A): A {
  if (!profile) return run();
  const end = profile.begin(step);
  try {
    return run();
  } finally {
    end();
  }
}

export function searchEffect<A, E, R>(
  profile: SearchProfiler | null,
  step: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (!profile) return effect;
  return Effect.suspend(() => {
    const end = profile.begin(step);
    return effect.pipe(Effect.ensuring(Effect.sync(end)));
  });
}
