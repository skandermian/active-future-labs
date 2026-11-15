import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Cesium ships workers and static assets that must be served next to the app.
const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesium';

export default defineConfig({
  // Relative base so the build works on GitHub Pages or any sub-path.
  base: './',
  define: {
    CESIUM_BASE_URL: JSON.stringify(`./${cesiumBaseUrl}`),
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
        // Only the Cesium assets this globe uses (skips ~170 icon and
        // offline-imagery files: we ship our own NASA base image).
        { src: `${cesiumSource}/Assets/IAU2006_XYS`, dest: `${cesiumBaseUrl}/Assets` },
        { src: `${cesiumSource}/Assets/Images`, dest: `${cesiumBaseUrl}/Assets` },
        { src: `${cesiumSource}/Assets/approximateTerrainHeights.json`, dest: `${cesiumBaseUrl}/Assets` },
        { src: `${cesiumSource}/Assets/Textures/SkyBox`, dest: `${cesiumBaseUrl}/Assets/Textures` },
        { src: `${cesiumSource}/Assets/Textures/LensFlare`, dest: `${cesiumBaseUrl}/Assets/Textures` },
        { src: `${cesiumSource}/Assets/Textures/moonSmall.jpg`, dest: `${cesiumBaseUrl}/Assets/Textures` },
        { src: `${cesiumSource}/Assets/Textures/waterNormals*.jpg`, dest: `${cesiumBaseUrl}/Assets/Textures` },
      ],
    }),
  ],
  build: {
    chunkSizeWarningLimit: 6000,
  },
});
