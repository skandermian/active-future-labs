# Architecture

## Data flow

```
NASA services ──> backend notebook (Colab) ──> nasa_cache.sqlite3 (360 boxes × 10 variables × 300 months + trend results)
                                                        │
                                   backend/export/export_frontend_data.py
                                                        │
                                                        ▼
                                  frontend/public/data/*.json (≈7 MB, static)
                                                        │
                                       sources/trendData.js (portable)
                                                        │
                                   backend/intel/detectors.py ──> intel.json
                                   (drift · erratic · conflict · migrate · early warning)
                                                        │
        ┌───────────────────────┬───────────────────────┼───────────────────────┐
   layers/sites           layers/links          layers/studyBoxes            ui/*
 (markers, reticle)   (migration arrows)   (trend field for focus)   (status bar, feed, dossier)
```

The backend owns every statistic. The frontend never refits a trend: it only reads `trend_results` and the stored series.

## What we took from God's Eye View

God's Eye View's application shell is tied to its live feeds (flights, CCTV, voice, Google tokens). Its **layers**, though, are portable modules that depend only on CesiumJS plus a small host interface (see its `docs/INFRASTRUCTURE-LAYERS.md`). We built a lean host that provides that interface and wrote our layers to the same contract.

| God's Eye View | Here | Why it matters |
|---|---|---|
| Layer contract `init/enable/disable/update/destroy/getStats` | `core/layerManager.js`, `layers/studyBoxes` | Any of its layers (e.g. `recentImagery` for NASA GIBS daily imagery, `firms` for fires, `weather` clock) can be adapted in |
| Earthquakes layer (source → records → CustomDataSource) | `layers/studyBoxes/index.js` | Same shape, one data source, recolour-only updates |
| `contextStore` (registerEntityContext / select) | `core/contextStore.js` | Several layers can draw the same place and still agree on what was picked |
| `layerSnapshot` feed states, worst state wins | `core/feedState.js` | A failed or partial load is shown, never hidden behind a working layer |
| Portable `sources/*` (no Cesium, no DOM) | `sources/trendData.js` | The same code runs in the browser and in Node tests |
| Tool catalog `defineTool` → `{summary, data}` | `tools/catalog.js`, `tools/queries.js` | The UI uses these today; an assistant could call the same tools, so every number it repeats comes from the data |
| Composition root `standalone/application.js` | `main.js` | One place builds services; nothing else reads globals |
| Director scene documents with GeoJSON data packs | not yet | Natural fit for guided demo tours and the final video |

## Adding a detector

1. Add a function to `backend/intel/detectors.py` that returns a value and a p-value per site, correct the family with Benjamini–Hochberg, and emit signals with `add(site, type, var, value, unit, q, grade, headline, score)`.
2. Add the type to `SIGNAL_TYPES` in `src/intel/signals.js` (label, glyph, colour validated against the others) and to `FILTER_ORDER`.
3. The feed, tally, globe colouring and dossier pick it up. If it found nothing after correction, report it under `detectors` as a null result rather than inventing signals.

## Adding an idea: write a lens

A lens answers one question about the same 360 places. It does not draw anything itself.

```js
// src/lenses/myIdea.js
export function createMyIdeaLens() {
  let core;
  return {
    id: 'my-idea',
    label: 'My idea',
    question: 'The question this lens answers, in plain words',
    usesTimeline: false,
    async prepare({ core: c, source, state }) { core = c; /* load data, e.g. await source.annual(state.variable) */ },
    paint(regionIndex) { return { rgb: [r, g, b], alpha: 0.9 }; /* or null to hide the box */ },
    legend() { return { gradient, left, right, unit, poles: ['low word', 'high word'], note }; },
  };
}
```

Then add it to `LENSES` in `src/lenses/index.js`. The tab, globe colouring, legend and URL follow automatically. If the idea needs new numbers (e.g. a stability score per place), compute them in the export script or the backend and add them to the JSON, so the browser stays a reader.

If the panel should show something lens-specific, add a tool in `tools/queries.js` (returning `{ summary, data }`) and a renderer in `ui/panel.js`.

## Decisions

- **Static JSON, no live server.** Judges and visitors get a site that works tomorrow; Colab is only for collecting data.
- **No API keys.** NASA GIBS imagery, bundled as one image with sharper tiles on top when reachable.
- **Mobile first.** Bottom sheet on phones, side panel from 960 px. Render-on-demand globe to save battery.
- **Evidence encoded twice.** Solid vs faint on the globe, and an icon + text badge in the panel, so significance never relies on colour alone.
- **Colour.** Diverging blue / grey / red, interpolated in OKLab. Red always means warmer, drier, hazier or more evaporation; blue means cooler or wetter. The poles were checked with a colour-vision validator on the dark surface.
