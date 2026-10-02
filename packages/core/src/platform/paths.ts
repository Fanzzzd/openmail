import { Context, Effect } from "effect";
export class AppPaths extends Context.Service<
  AppPaths,
  { readonly dataDirectory: Effect.Effect<string> }
>()("openmail/AppPaths") {}
export const dataDir = Effect.flatMap(AppPaths, (paths) => paths.dataDirectory);
