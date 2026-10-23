import { lazy, Suspense, type ComponentType } from "react";

/** A lazy dialog; `preload` starts its import without rendering it. */
export type LazyDialog<P extends object> = ComponentType<P> & { preload: () => void };

/** Each dialog owns its loading boundary so mail stays visible during import. */
export function lazyDialog<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyDialog<P> {
  let loading: Promise<{ default: ComponentType<P> }> | undefined;
  const once = () => (loading ??= load());
  const Component = lazy(once);
  function LazyDialog(props: P) {
    return (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    );
  }
  return Object.assign(LazyDialog, {
    preload: () => {
      void once();
    },
  });
}
