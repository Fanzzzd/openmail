import { lazy, Suspense, type ComponentType } from "react";

/** Each dialog owns its loading boundary so mail stays visible during import. */
export function lazyDialog<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  const Component = lazy(load);
  return function LazyDialog(props: P) {
    return (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    );
  };
}
