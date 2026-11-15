/**
 * One small observable state object for the whole app.
 *
 * Every part of the UI reads from here and writes through `set`, so the globe,
 * the panel and the controls can never disagree about what is selected.
 */
export function createStore(initial) {
  let state = { ...initial };
  const listeners = new Set();

  return {
    get: () => state,
    /** Merge a patch; listeners receive (next, previous, changedKeys). */
    set(patch) {
      const changed = Object.keys(patch).filter((k) => !Object.is(state[k], patch[k]));
      if (!changed.length) return;
      const previous = state;
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state, previous, changed);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
