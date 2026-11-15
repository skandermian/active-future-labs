import * as Cesium from 'cesium';
import { SIGNAL_TYPES } from '../../intel/signals.js';

/** Great-circle arc lifted off the surface, so links read as links, not borders. */
export function arcPositions(a, b, segments = 48) {
  const start = Cesium.Cartographic.fromDegrees(a.lon, a.lat);
  const end = Cesium.Cartographic.fromDegrees(b.lon, b.lat);
  const geo = new Cesium.EllipsoidGeodesic(start, end);
  const lift = Math.min(900_000, 80_000 + geo.surfaceDistance * 0.12);
  const out = [];
  for (let k = 0; k <= segments; k++) {
    const t = k / segments;
    const c = geo.interpolateUsingFraction(t);
    out.push(Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, Math.sin(Math.PI * t) * lift));
  }
  return out;
}

/**
 * Climate-migration links: each site whose 2020–24 climate now best matches
 * another site's 2000–04 climate gets an arrow towards that site. All links
 * show under the Migrate filter; otherwise only the selected site's link.
 */
export function createLinksLayer({ regions, intel }) {
  let lines = null;
  let drawn = 0;
  const links = intel.signals.filter((s) => s.type === 'migrate').map((s) => ({ from: s.site, to: s.target, score: s.score }));
  const blue = Cesium.Color.fromCssColorString(SIGNAL_TYPES.migrate.color);

  function draw(list, emphasis) {
    lines.removeAll();
    drawn = 0;
    for (const l of list) {
      lines.add({
        positions: arcPositions(regions[l.from], regions[l.to]),
        width: emphasis ? 9 : 4,
        material: Cesium.Material.fromType('PolylineArrow', { color: blue.withAlpha(emphasis ? 0.95 : 0.15 + 0.55 * Math.min(1, l.score)) }),
      });
      drawn += 1;
    }
  }

  return {
    id: 'links',
    name: 'Climate migration links',
    init(viewer) {
      lines = viewer.scene.primitives.add(new Cesium.PolylineCollection());
      lines.show = false;
    },
    enable() {
      lines.show = true;
    },
    disable() {
      lines.show = false;
    },
    update(viewer, { filter = 'all', selectedIndex = null }) {
      if (selectedIndex !== null) {
        const own = links.filter((l) => l.from === selectedIndex || l.to === selectedIndex);
        draw(own, true);
      } else if (filter === 'migrate') draw(links.slice(0, 40), false); // strongest 40: the rest stay in the feed
      else draw([], false);
    },
    destroy(viewer) {
      viewer.scene.primitives.remove(lines);
      lines = null;
    },
    getStats() {
      return { count: links.length, drawn, state: 'nominal' };
    },
  };
}
