# EARTHWATCH — Earth change intelligence console

Not a map of trends. A detector engine scans 360 sites × 10 NASA records (four systems: MERRA-2, MERRA-2 aerosol, GPM IMERG, GLDAS; 2000–2024) and raises **signals**. The console fuses them per site into a dossier, God's Eye View style: signal feed → globe → dossier.

| Detector | Question | Result (after correcting for every test) |
|---|---|---|
| ▲ Drift | Is the average moving? | 1,255 signals (rain and soil pairs that agree are fused into one) |
| ≈ Erratic / ∼ Steadier | Are the swings getting bigger or smaller? | 188 growing, 102 shrinking; 125 of the 290 at places whose average did not move |
| ✕ Conflict | Do independent NASA systems disagree? | 104 (20 soil + 3 rain where both systems are significant but opposite) |
| → Migrate | Does this place's 2020–24 climate now resemble another place's 2000–04 climate? | 116 sites, against ~49 from noise alone over 5 years: leads, not findings |
| ◌ Early warning | Is it losing the ability to bounce back? | 0 of 1,789: raw hits at the chance rate. Shown as "watched, nothing detected" |
| ◌ Change types | Do places fall into natural groups? | No (silhouette ≤ 0.22). Not shown as a finding |

## Run it

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173
npm test             # 18 tests: colour scale, data consistency, signal integrity
npm run build        # static site in frontend/dist/
```

`public/data/` is already filled. To rebuild it from the backend database:

```bash
pip install reverse_geocoder pycountry pandas numpy statsmodels scikit-learn
python backend/export/export_frontend_data.py path/to/nasa_cache.sqlite3 frontend/public/data
python backend/intel/detectors.py frontend/public/data        # writes intel.json (~20 s)
```

Links keep the view: `#site=0092&var=PRECTOTCORR`, `#filter=conflict`.

## Layout

- **Phone:** status bar, globe, then Signals / Dossier tabs.
- **Tablet (≥ 900 px):** panel with tabs beside the globe.
- **Desktop (≥ 1280 px):** detectors and feed | globe | dossier.

## Panes

- **Status bar:** the four NASA systems with feed status, sites, series, signals, archive period.
- **Detectors (also the filter):** count per signal type, plus the two detectors that found nothing.
- **Signal feed:** every signal ranked by priority, searchable by site, country or finding; grade (Confirmed / Probable / Lead) and rank.
- **Globe:** one marker per site, sized by fused signal strength and coloured by its strongest signal under the active filter. Opening a site adds a reticle, its migration arrow, and a faint field of the chosen record's trend at every site.
- **Dossier:**
  - assessment written from the detector output (no language model)
  - the site's signals
  - whether the paired systems agree
  - evidence matrix (drift, swings and memory for all 10 records)
  - chart with trend fan and swing band
  - climate match
  - sources and methods

## Code map

```
src/
  main.js               composition root
  core/                 globe, layer host (God's Eye View contract), context store, feed state, store
  sources/trendData.js  static JSON in, plain records out (no Cesium)
  intel/signals.js      signal vocabulary, colours, filters (pure, tested)
  layers/
    sites/              site markers + selection reticle
    links/              climate-migration arrows
    studyBoxes/         faint trend field for the focused record
    colorScale.js       diverging scale for direction of change
  lenses/trend.js       paints the trend field
  ui/                   status bar, feed, dossier, chart
  tools/                read-only query tools returning { summary, data }
```

## Known limits

- Boxes are 2°×2°; names come from the nearest town in an offline gazetteer.
- Erratic: for rain and runoff, swings grow naturally when the average grows; read it alongside drift.
- Migrate: any single match can be noise; the excess over the 5-year baseline is the finding.
- Validate before presenting: strong MERRA-2 cooling and wetting in parts of the Central African Republic.
