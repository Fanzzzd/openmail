import { Effect } from "effect";

/** Lazy pages in the caller's Effect fiber. The caller must run each yielded loader before advancing. */
export function* gmailPages<A extends { readonly nextPageToken?: string }, E, R>(
  load: (token: string | undefined) => Effect.Effect<A, E, R>,
): Generator<Effect.Effect<A, E, R>, void, unknown> {
  let token: string | undefined;
  for (;;) {
    yield load(token).pipe(
      Effect.tap((page) =>
        Effect.sync(() => {
          token = page.nextPageToken;
        }),
      ),
    );
    if (!token) return;
  }
}

/** Graph links are advanced by the caller only after nextPage validates them. */
export function* graphPages<A, E, R>(
  initial: string,
  load: (path: string) => Effect.Effect<A, E, R>,
  following: () => string | null | undefined,
): Generator<Effect.Effect<A, E, R>, void, unknown> {
  let path: string | null | undefined = initial;
  while (path) {
    yield load(path);
    path = following();
  }
}
