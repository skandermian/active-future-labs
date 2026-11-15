import * as Cesium from 'cesium';

/**
 * Study-box layer, built on God's Eye View's earthquake layer template
 * (one CustomDataSource, init/enable/disable/update/destroy, getStats).
 *
 * It draws the 360 boxes once and only recolours them when the lens,
 * variable or year changes. What colour a box gets is decided by the active
 * lens (`lens.paint(index) -> {rgb, alpha}`), so new lenses need no new layer.
 */
export function createStudyBoxesLayer({ contextStore, regions }) {
  if (!Array.isArray(regions)) throw new TypeError('Study boxes need regions');
  let dataSource = null;
  let entities = [];
  let lastError = null;
  let painted = 0;
  let selectedIndex = null;

  const outlineDefault = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.18);
  const outlineSelected = Cesium.Color.fromCssColorString('#ffffff');

  const layer = {
    id: 'study-boxes',
    name: 'Study areas',

    init(viewer) {
      dataSource = new Cesium.CustomDataSource('study-boxes');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      entities = regions.map((region, index) => {
        const [w, s, e, n] = region.bbox;
        const entity = dataSource.entities.add({
          id: `box:${region.id}`,
          name: region.name,
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(w, s, e, n),
            material: Cesium.Color.TRANSPARENT,
            height: 0,
            outline: true,
            outlineColor: outlineDefault,
            outlineWidth: 1,
          },
        });
        contextStore.register(entity.id, { layerId: layer.id, kind: 'region', key: index, record: region });
        return entity;
      });
    },

    enable() {
      if (dataSource) dataSource.show = true;
    },

    disable() {
      if (dataSource) dataSource.show = false;
    },

    /** state: { lens, selectedIndex } — the lens decides every box's paint. */
    update(viewer, { lens, selectedIndex: sel }) {
      try {
        painted = 0;
        entities.forEach((entity, index) => {
          const paint = lens?.paint(index);
          const rect = entity.rectangle;
          if (!paint || !paint.rgb) {
            rect.material = Cesium.Color.TRANSPARENT;
          } else {
            const [r, g, b] = paint.rgb;
            rect.material = new Cesium.Color(r / 255, g / 255, b / 255, paint.alpha);
            painted += 1;
          }
          rect.outlineColor = index === sel ? outlineSelected : outlineDefault;
        });
        selectedIndex = sel;
        lastError = null;
      } catch (error) {
        lastError = error;
        console.error('[Layer:study-boxes] paint failed', error);
      }
    },

    destroy(viewer) {
      contextStore.removeForLayer(layer.id);
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      entities = [];
    },

    getStats() {
      return {
        count: entities.length,
        painted,
        selectedIndex,
        state: lastError ? 'unavailable' : entities.length ? 'nominal' : 'loading',
        error: lastError?.message ?? null,
      };
    },
  };
  return layer;
}
