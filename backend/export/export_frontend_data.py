"""Export the NASA trend database to static JSON for the frontend.

Usage:
    python backend/export/export_frontend_data.py path/to/nasa_cache.sqlite3 frontend/public/data

Reads only what the backend already stored (observations, trend_results,
trend_diagnostics, regions). Adds two derived, clearly labelled fields:
  * a place name from the offline GeoNames reverse geocoder
  * a simplified Koppen climate class from the box's own 2000-2024 climatology
Writes:
  manifest.json            data version, period, variables, counts
  regions.json             one record per study box (order = index used everywhere)
  trends.json              per variable: arrays aligned to regions
  annual/<VAR>.json        yearly anomaly per region (for the timeline)
  monthly/<VAR>.json       monthly values per region (for the detail chart)
"""
from __future__ import annotations

import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

VARIABLES = {
    # id: (label, unit, family, source, plain definition, decimals)
    'T2M': ('Air temperature', '°C', 'air', 'NASA POWER (MERRA-2)',
            'Temperature of the air 2 m above the ground.', 2),
    'RH2M': ('Humidity', '%', 'air', 'NASA POWER (MERRA-2)',
             'How close the air is to holding all the water vapour it can.', 1),
    'aerosol': ('Haze', 'AOD', 'air', 'MERRA-2 aerosol (M2TMNXAER)',
                'How much dust, smoke, pollution and sea salt dims sunlight. 0 = perfectly clear.', 3),
    'dust': ('Desert dust', 'AOD', 'air', 'MERRA-2 aerosol (M2TMNXAER)',
             'The part of the haze made of desert dust.', 3),
    'PRECTOTCORR': ('Rainfall (model)', 'mm/day', 'water', 'NASA POWER (MERRA-2)',
                    'Rain and snow, from the MERRA-2 model corrected with rain gauges.', 2),
    'gpm_rain': ('Rainfall (satellite)', 'mm/day', 'water', 'GPM IMERG V07',
                 'Rain measured by the Global Precipitation Measurement satellites.', 2),
    'evaporation': ('Evaporation', 'mm/day', 'water', 'GLDAS Noah 2.1',
                    'Water leaving the land and plants into the air.', 2),
    'runoff': ('Runoff', 'mm/day', 'water', 'GLDAS Noah 2.1',
               'Rainwater flowing off the surface towards rivers.', 3),
    'GWETTOP': ('Topsoil wetness', '0–1', 'land', 'NASA POWER (MERRA-2)',
                'How wet the top layer of soil is: 0 = bone dry, 1 = soaked.', 3),
    'soil_moisture': ('Soil moisture', 'kg/m²', 'land', 'GLDAS Noah 2.1',
                      'Water held in the top 10 cm of soil (1 kg/m² ≈ 1 mm of water).', 2),
}
ALPHA = 0.05
NAME_RADIUS_KM = 250
COUNTRY_SHORT = {'Russian Federation': 'Russia', 'Iran, Islamic Republic of': 'Iran', 'Viet Nam': 'Vietnam',
                 'Korea, Republic of': 'South Korea', "Korea, Democratic People's Republic of": 'North Korea',
                 'Syrian Arab Republic': 'Syria', 'Tanzania, United Republic of': 'Tanzania',
                 'Venezuela, Bolivarian Republic of': 'Venezuela', 'Bolivia, Plurinational State of': 'Bolivia',
                 "Lao People's Democratic Republic": 'Laos', 'Congo, The Democratic Republic of the': 'DR Congo',
                 'Moldova, Republic of': 'Moldova', 'United States': 'USA', 'United Kingdom': 'UK'}


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(a))


def fmt_coord(lat, lon):
    return f"{abs(lat):.0f}°{'N' if lat >= 0 else 'S'}, {abs(lon):.0f}°{'E' if lon >= 0 else 'W'}"


def koppen(t_monthly: np.ndarray, p_monthly_mm_day: np.ndarray, lat: float):
    """Simplified Koppen class from 12 monthly means (temperature °C, precip mm/day)."""
    days = np.array([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    p_mon = p_monthly_mm_day * days
    tmin, tmax, tann = t_monthly.min(), t_monthly.max(), t_monthly.mean()
    p_ann = p_mon.sum()
    summer = slice(3, 9) if lat >= 0 else np.r_[0:3, 9:12]
    summer_share = p_mon[summer].sum() / p_ann if p_ann > 0 else 0
    thr = 20 * tann + (280 if summer_share >= 0.7 else 140 if summer_share >= 0.3 else 0)
    if tmax < 10:
        return 'E', 'Polar'
    if p_ann < thr:
        return ('BW', 'Desert') if p_ann < thr / 2 else ('BS', 'Steppe')
    if tmin >= 18:
        if p_mon.min() >= 60:
            return 'Af', 'Tropical rainforest'
        return ('Am', 'Tropical monsoon') if p_mon.min() >= 100 - p_ann / 25 else ('Aw', 'Tropical savanna')
    if tmin > -3:
        return 'C', 'Temperate'
    return 'D', 'Cold continental'


def r(x, d):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def main(db_path: str, out_dir: str):
    out = Path(out_dir)
    (out / 'annual').mkdir(parents=True, exist_ok=True)
    (out / 'monthly').mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)

    regions = pd.read_sql('SELECT * FROM regions ORDER BY region_id', con)
    regions['lat'] = (regions.south + regions.north) / 2
    regions['lon'] = (regions.west + regions.east) / 2
    index = {rid: i for i, rid in enumerate(regions.region_id)}

    obs = pd.read_sql('SELECT region_id, variable, date, value FROM observations', con,
                      parse_dates=['date'])
    obs['i'] = obs.region_id.map(index)
    months = pd.date_range(obs.date.min(), obs.date.max(), freq='MS')
    years = sorted(set(months.year))

    # ---- place names (offline GeoNames) + climate class ------------------
    import reverse_geocoder as rg
    import pycountry
    hits = rg.search(list(zip(regions.lat, regions.lon)), mode=1, verbose=False)
    clim = obs[obs.variable.isin(['T2M', 'PRECTOTCORR'])].copy()
    clim['m'] = clim.date.dt.month
    clim = clim.groupby(['i', 'variable', 'm']).value.mean().unstack('m')

    region_records = []
    for i, row in regions.iterrows():
        h = hits[i]
        dist = haversine_km(row.lat, row.lon, float(h['lat']), float(h['lon']))
        country = pycountry.countries.get(alpha_2=h['cc'])
        country = getattr(country, 'common_name', None) or getattr(country, 'name', h['cc'])
        country = COUNTRY_SHORT.get(country, country)
        if not row.region_label.startswith('Global study area'):
            name = row.region_label.replace(' study area', '').replace(' study box', '').replace('-area', '')
        elif dist <= NAME_RADIUS_KM:
            place, admin = h['name'], h['admin1']
            name = place if not admin or admin == place else f"{place}, {admin}"
        else:
            name = f"Remote {fmt_coord(row.lat, row.lon)}"
        code, label = koppen(clim.loc[(i, 'T2M')].to_numpy(), clim.loc[(i, 'PRECTOTCORR')].to_numpy(), row.lat)
        region_records.append({
            'id': row.region_id, 'name': name,
            'nearest_place': {'name': h['name'], 'admin1': h['admin1'], 'country': country,
                              'distance_km': round(dist)},
            'featured': not row.region_label.startswith('Global study area'),
            'lat': round(row.lat, 3), 'lon': round(row.lon, 3),
            'bbox': [round(row.west, 3), round(row.south, 3), round(row.east, 3), round(row.north, 3)],
            'climate': {'code': code, 'label': label},
        })

    # ---- trends ----------------------------------------------------------
    tr = pd.read_sql('SELECT * FROM trend_results', con)
    diag = pd.read_sql('SELECT region_id, variable, diagnostic_json FROM trend_diagnostics', con)
    tr = tr.merge(diag, on=['region_id', 'variable'], how='left')
    n_regions = len(regions)
    trends = {'alpha': ALPHA,
              'method': 'Seasonal OLS with month dummies, Newey-West HAC(12) errors; '
                        'Benjamini-Hochberg false-discovery correction across all fitted series',
              'period': [int(tr.start_year.min()), int(tr.end_year.max())],
              'n_tests': int(len(tr)), 'variables': {}}
    for var, (_, _, _, _, _, d) in VARIABLES.items():
        sub = tr[tr.variable == var].set_index('region_id')
        cols = {k: [None] * n_regions for k in
                ('slope', 'ci_low', 'ci_high', 'p_raw', 'p_bh', 'verdict', 'autocorr_flag', 'hac_sensitive',
                 'sen_slope', 'n_months')}
        for rid, row in sub.iterrows():
            i = index[rid]
            dj = json.loads(row.diagnostic_json) if isinstance(row.diagnostic_json, str) else {}
            sen = (dj.get('annual_theil_sen') or {}).get('annual_theil_sen_per_decade')
            cols['slope'][i] = r(row.trend_per_decade, d + 2)
            cols['ci_low'][i] = r(row.ci_low, d + 2)
            cols['ci_high'][i] = r(row.ci_high, d + 2)
            cols['p_raw'][i] = r(row.p_raw, 6)
            cols['p_bh'][i] = r(row.p_bh, 6)
            cols['verdict'][i] = ('significant' if row.p_bh < ALPHA else
                                  'suggestive' if row.p_raw < ALPHA else 'not_significant')
            cols['autocorr_flag'][i] = bool(dj.get('residual_autocorrelation_flag', False))
            cols['hac_sensitive'][i] = bool(dj.get('significance_sensitivity_hac12_vs_24', False))
            cols['sen_slope'][i] = r(sen, d + 2)
            cols['n_months'][i] = int(row.n_months)
        slopes = np.array([s for s in cols['slope'] if s is not None])
        cols['scale'] = r(np.nanpercentile(np.abs(slopes), 95), d + 2) if len(slopes) else None
        trends['variables'][var] = cols

    # ---- series ----------------------------------------------------------
    for var, (_, _, _, _, _, d) in VARIABLES.items():
        sub = obs[obs.variable == var]
        grid = np.full((n_regions, len(months)), np.nan)
        pos = {m: j for j, m in enumerate(months)}
        grid[sub.i.to_numpy(), sub.date.map(pos).to_numpy()] = sub.value.to_numpy()
        monthly = [[r(v, d) for v in row] for row in grid]
        (out / 'monthly' / f'{var}.json').write_text(json.dumps(
            {'variable': var, 'start': months[0].strftime('%Y-%m'), 'values': monthly},
            separators=(',', ':')))
        # yearly anomaly vs the box's own 2000-2024 monthly climatology
        clim_m = np.nanmean(grid.reshape(n_regions, -1, 12), axis=1)
        anom = grid.reshape(n_regions, -1, 12) - clim_m[:, None, :]
        with np.errstate(invalid='ignore'):
            annual = np.nanmean(anom, axis=2)
        (out / 'annual' / f'{var}.json').write_text(json.dumps(
            {'variable': var, 'years': years,
             'scale': r(np.nanpercentile(np.abs(annual), 95), d + 1),
             'values': [[r(v, d + 1) for v in row] for row in annual]},
            separators=(',', ':')))

    # Unique site names: a second box near the same town gets its compass side.
    seen = {}
    for rec in region_records:
        seen.setdefault(rec['name'], []).append(rec)
    for name, group in seen.items():
        if len(group) > 1:
            for rec in group:
                ref = group[0]
                dy, dx = rec['lat'] - sum(g['lat'] for g in group) / len(group), rec['lon'] - sum(g['lon'] for g in group) / len(group)
                side = ('N' if dy > 0 else 'S') if abs(dy) >= abs(dx) else ('E' if dx > 0 else 'W')
                rec['name'] = f"{name} ({side})"
    seen = {}
    for rec in region_records:
        seen[rec['name']] = seen.get(rec['name'], 0) + 1
        if seen[rec['name']] > 1:
            rec['name'] = f"{rec['name']} {seen[rec['name']]}"
    for rec in region_records:
        rec['country'] = rec['nearest_place']['country']

    (out / 'regions.json').write_text(json.dumps(region_records, separators=(',', ':'), ensure_ascii=False))
    (out / 'trends.json').write_text(json.dumps(trends, separators=(',', ':')))
    manifest = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source_database': Path(db_path).name,
        'period': {'start': months[0].strftime('%Y-%m'), 'end': months[-1].strftime('%Y-%m')},
        'regions': n_regions,
        'variables': [{'id': k, 'label': v[0], 'unit': v[1], 'family': v[2], 'source': v[3],
                       'definition': v[4], 'decimals': v[5]} for k, v in VARIABLES.items()],
        'derived_fields': {
            'name': f'Offline GeoNames reverse geocode of the box centre; "Remote area" when the nearest '
                    f'populated place is over {NAME_RADIUS_KM} km away.',
            'climate': 'Simplified Koppen class from the box\'s own 2000-2024 monthly T2M and PRECTOTCORR.',
        },
    }
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    print(json.dumps({'regions': n_regions, 'months': len(months), 'trends': int(len(tr))}))


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
