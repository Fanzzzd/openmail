/** A failed initialization must never poison subsequent requests. */
export function resettableLoader(factory) {
  let pending;
  return () => {
    pending ??= Promise.resolve()
      .then(factory)
      .catch((error) => {
        pending = undefined;
        throw error;
      });
    return pending;
  };
}
