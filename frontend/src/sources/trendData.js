/**
 * Portable data source, after God's Eye View's `src/sources/*` contract.
 *
 * No Cesium, no DOM: it only fetches the static JSON written by
 * backend/export/export_frontend_data.py and hands back plain records. The
 * same module runs in the browser and in Node tests (pass a `fetchJson`).
 */
export function createTrendDataSource({ baseUrl, fetchJson = defaultFetchJson }) {
  const url = (path) => `${baseUrl.replace(/\/?$/, '/')}${path}`;
  let core = null;
  const annual = new Map(); // variable -> Promise<{years, scale, values}>
  const monthly = new Map(); // variable -> Promise<{start, values}>

  async function loadCore() {
    if (!core) {
      core = Promise.all([
        fetchJson(url('manifest.json')),
        fetchJson(url('regions.json')),
        fetchJson(url('trends.json')),
        fetchJson(url('intel.json')),
        fetchJson(url('deep.json')).catch(() => null), // optional: deep statistics + disaster outlook
      ]).then(([manifest, regions, trends, intel, deep]) => ({
        manifest,
        regions,
        trends,
        intel,
        deep,
        variables: Object.fromEntries(manifest.variables.map((v) => [v.id, v])),
      }));
    }
    return core;
  }

  function lazy(cache, folder, variable) {
    if (!cache.has(variable)) cache.set(variable, fetchJson(url(`${folder}/${variable}.json`)));
    return cache.get(variable);
  }

  return {
    loadCore,
    annual: (variable) => lazy(annual, 'annual', variable),
    monthly: (variable) => lazy(monthly, 'monthly', variable),
  };
}

async function defaultFetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${path}`);
  return response.json();
}

/** Plain record for one place and one variable, the shape every view reads. */
export function trendRecord(core, regionIndex, variable) {
  const t = core.trends.variables[variable];
  const region = core.regions[regionIndex];
  if (!t || !region) return null;
  const slope = t.slope[regionIndex];
  return {
    regionIndex,
    region,
    variable: core.variables[variable],
    available: slope !== null && slope !== undefined,
    slope,
    ciLow: t.ci_low[regionIndex],
    ciHigh: t.ci_high[regionIndex],
    pRaw: t.p_raw[regionIndex],
    pAdjusted: t.p_bh[regionIndex],
    verdict: t.verdict[regionIndex] ?? 'no_data',
    autocorrFlag: t.autocorr_flag[regionIndex],
    hacSensitive: t.hac_sensitive[regionIndex],
    senSlope: t.sen_slope[regionIndex],
    months: t.n_months[regionIndex],
    scale: t.scale,
  };
}
