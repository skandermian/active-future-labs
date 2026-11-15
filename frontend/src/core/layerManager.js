/**
 * Layer host implementing God's Eye View's layer contract.
 *
 * A layer is a plain object:
 *   { id, name, init(viewer), enable(viewer), disable(viewer),
 *     update(viewer, state), destroy(viewer), getStats() }
 * Layers depend only on CesiumJS and on the host services passed to their
 * factory (context store, render request). That is the same contract God's
 * Eye View's portable layers use, so its layers can be adapted into this host
 * and ours could be lifted back into it.
 */
export function createLayerManager({ viewer, requestRender }) {
  const layers = new Map();
  const enabled = new Set();

  function assertLayer(layer) {
    for (const fn of ['init', 'enable', 'disable', 'update', 'destroy', 'getStats'])
      if (typeof layer[fn] !== 'function') throw new TypeError(`Layer ${layer.id} lacks ${fn}()`);
  }

  return {
    register(layer) {
      assertLayer(layer);
      if (layers.has(layer.id)) throw new Error(`Layer ${layer.id} is already registered`);
      layers.set(layer.id, layer);
      layer.init(viewer);
      return layer;
    },
    setEnabled(id, on) {
      const layer = layers.get(id);
      if (!layer) throw new Error(`Unknown layer ${id}`);
      if (on && !enabled.has(id)) {
        enabled.add(id);
        layer.enable(viewer);
      } else if (!on && enabled.has(id)) {
        enabled.delete(id);
        layer.disable(viewer);
      }
      requestRender();
    },
    /** Push the current app state to every enabled layer. */
    update(state) {
      for (const id of enabled) layers.get(id).update(viewer, state);
      requestRender();
    },
    stats() {
      return [...layers.values()].map((l) => ({ id: l.id, enabled: enabled.has(l.id), ...l.getStats() }));
    },
    destroy() {
      for (const layer of layers.values()) layer.destroy(viewer);
      layers.clear();
      enabled.clear();
    },
  };
}
