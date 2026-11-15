import * as Cesium from 'cesium';
import { SIGNAL_TYPES, hexToRgb, siteLead } from '../../intel/signals.js';

const RETICLE = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="white" stroke-width="2">' +
    '<path d="M2 14V2h12M34 2h12v12M46 34v12H34M14 46H2V34"/><path d="M24 18v-6M24 36v-6M18 24h-6M36 24h-6" stroke-width="1.5"/></svg>',
)}`;

/**
 * Site markers: one point per study site, sized by fused signal strength and
 * coloured by the strongest signal of the active filter. God's Eye View layer
 * contract (init/enable/disable/update/destroy/getStats).
 */
export function createSitesLayer({ contextStore, regions, intel }) {
  let points = null;
  let reticles = null;
  let reticle = null;
  let shown = 0;
  let lastError = null;
  const maxScore = Math.max(...intel.sites.map((s) => s.score), 1);
  // Smaller marks on phones, where the globe is a few hundred pixels across.
  const k = typeof window !== 'undefined' && window.innerWidth < 600 ? 0.7 : 1;
  const quiet = Cesium.Color.fromCssColorString('#5b616b').withAlpha(0.55);

  const layer = {
    id: 'sites',
    name: 'Study sites',

    init(viewer) {
      points = viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
      reticles = viewer.scene.primitives.add(new Cesium.BillboardCollection());
      regions.forEach((r, index) => {
        const id = `site:${r.id}`;
        points.add({
          id,
          position: Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 2000),
          pixelSize: 6,
          color: quiet,
          outlineColor: Cesium.Color.fromCssColorString('#0b0d10'),
          outlineWidth: 1.5,
          scaleByDistance: new Cesium.NearFarScalar(2.0e6, 1.5, 2.4e7, 0.6),
        });
        contextStore.register(id, { layerId: layer.id, kind: 'site', key: index, record: r });
      });
      reticle = reticles.add({
        image: RETICLE,
        position: Cesium.Cartesian3.ZERO,
        show: false,
        width: 44,
        height: 44,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      points.show = false;
      reticles.show = false;
    },

    enable() {
      points.show = true;
      reticles.show = true;
    },

    disable() {
      points.show = false;
      reticles.show = false;
    },

    /** state: { filter, selectedIndex } */
    update(viewer, { filter = 'all', selectedIndex = null }) {
      try {
        shown = 0;
        for (let i = 0; i < points.length; i++) {
          const p = points.get(i);
          const lead = siteLead(intel, i, filter);
          const site = intel.sites[i];
          if (!lead) {
            p.color = quiet;
            p.pixelSize = 4 * k;
            continue;
          }
          shown += 1;
          const meta = SIGNAL_TYPES[lead.type];
          const [r, g, b] = hexToRgb(meta.color);
          const strength = filter === 'all' ? site.score / maxScore : Math.min(1, lead.score);
          p.color = meta.hollow ? new Cesium.Color(r / 255, g / 255, b / 255, 0.35) : new Cesium.Color(r / 255, g / 255, b / 255, 0.95);
          p.outlineColor = meta.hollow ? new Cesium.Color(r / 255, g / 255, b / 255, 1) : Cesium.Color.fromCssColorString('#0b0d10');
          p.pixelSize = k * (5 + 8 * Math.sqrt(Math.max(0, strength)));
        }
        if (selectedIndex !== null && regions[selectedIndex]) {
          const r = regions[selectedIndex];
          reticle.position = Cesium.Cartesian3.fromDegrees(r.lon, r.lat, 2000);
          reticle.show = true;
        } else reticle.show = false;
        lastError = null;
      } catch (error) {
        lastError = error;
        console.error('[Layer:sites] update failed', error);
      }
    },

    destroy(viewer) {
      contextStore.removeForLayer(layer.id);
      viewer.scene.primitives.remove(points);
      viewer.scene.primitives.remove(reticles);
      points = reticles = reticle = null;
    },

    getStats() {
      return { count: regions.length, shown, state: lastError ? 'unavailable' : 'nominal', error: lastError?.message ?? null };
    },
  };
  return layer;
}
