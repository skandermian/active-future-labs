/**
 * Entity context store, after God's Eye View's `data/contextStore.js`.
 *
 * Layers register what each drawn thing *is* (its owning layer and record);
 * the host resolves a pick on the globe to that record. This is the seam that
 * lets several layers draw the same place and still agree on what was picked.
 */
export function createContextStore() {
  const byEntity = new Map(); // entity/primitive id -> { layerId, kind, key, record }

  return {
    register(entityId, context) {
      if (!context?.layerId || context.key == null)
        throw new TypeError('Entity context needs a layerId and a key');
      byEntity.set(entityId, context);
    },
    resolve(entityId) {
      return byEntity.get(entityId) ?? null;
    },
    removeForLayer(layerId) {
      for (const [id, ctx] of byEntity) if (ctx.layerId === layerId) byEntity.delete(id);
    },
    size: () => byEntity.size,
  };
}
