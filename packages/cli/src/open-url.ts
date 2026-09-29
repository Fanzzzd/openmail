import { Browser, openInSystemBrowser } from "@openmail/core";
import { Console, Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/process";

/**
 * The CLI's browser: prints the consent URL on stderr, in case no browser can
 * be launched (SSH, headless), then hands it to the OS opener.
 */
export const CliBrowser: Layer.Layer<Browser, never, ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Browser,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return Browser.of({
        open: (url) =>
          Console.error(`Opening browser for sign-in:\n${url}`).pipe(
            Effect.andThen(openInSystemBrowser(url)),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
      });
    }),
  );
