import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

// NASA GIBS Blue Marble: keyless, global, and NASA's own imagery.
const GIBS_BLUE_MARBLE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg';

// Same imagery as one bundled 4096x2048 image: loads instantly and keeps the
// globe usable where the tile server is unreachable (offline, strict hosts).
const BUNDLED_BLUE_MARBLE = `${import.meta.env.BASE_URL}imagery/blue-marble-4096.jpg`;
const LOOK = { brightness: 0.62, saturation: 0.55, contrast: 1.05 };

/**
 * Create the globe. No Cesium ion token, no API keys: every visitor sees the
 * same thing without signing in anywhere.
 */
export function createViewer(container) {
  const baseLayer = Cesium.ImageryLayer.fromProviderAsync(
    Cesium.SingleTileImageryProvider.fromUrl(BUNDLED_BLUE_MARBLE, {
      credit: new Cesium.Credit('Imagery: NASA GIBS Blue Marble'),
    }),
    LOOK,
  );

  const viewer = new Cesium.Viewer(container, {
    baseLayer,
    terrain: undefined,
    animation: false,
    timeline: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    // Render only when something changes: much kinder to phone batteries.
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  // Sharper tiles on top when NASA GIBS is reachable; failures fall back
  // silently to the bundled image underneath instead of retrying forever.
  const tiles = new Cesium.UrlTemplateImageryProvider({ url: GIBS_BLUE_MARBLE, maximumLevel: 8 });
  tiles.errorEvent.addEventListener((error) => {
    error.retry = false;
  });
  viewer.imageryLayers.add(new Cesium.ImageryLayer(tiles, { ...LOOK, minimumTerrainLevel: 3 }));

  const { scene } = viewer;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b1220');
  scene.globe.showGroundAtmosphere = true;
  scene.skyAtmosphere.show = true;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#05070b');
  scene.fog.enabled = false;
  scene.screenSpaceCameraController.minimumZoomDistance = 600_000;
  scene.screenSpaceCameraController.maximumZoomDistance = 30_000_000;
  viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2) / (window.devicePixelRatio || 1);

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(10, 18, window.innerWidth < 600 ? 12_500_000 : window.innerWidth < 900 ? 17_000_000 : 15_500_000),
  });

  return viewer;
}

/** Fly to a place without changing how far out the camera is by much. */
export function flyToPlace(viewer, lon, lat, { height = 7_500_000, duration = 1.2 } = {}) {
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, height), duration });
}

/** Call onPick(entityId|null) for taps/clicks on the globe. */
export function onPick(viewer, onPickFn) {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((movement) => {
    const picked = viewer.scene.pick(movement.position);
    // Entities expose id.id; primitives (points, billboards) expose the id we set.
    const id = typeof picked?.id === 'string' ? picked.id : picked?.id?.id;
    onPickFn(id ?? null);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  return () => handler.destroy();
}
