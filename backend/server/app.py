"""EARTHWATCH live server: analyse the EXACT spot a user searches or clicks.

Run locally (from the project folder):
    pip install -r backend/server/requirements.txt
    uvicorn backend.server.app:app --reload --port 8000        # then http://localhost:8000/api/place?lat=53.48&lon=-2.24

What it does for any latitude/longitude:
  * downloads NASA POWER (MERRA-2) for that exact spot, 1981-2024: air temperature, rain, humidity, topsoil wetness, plus hottest and
    coldest temperatures, water vapour, root-zone soil wetness, sunshine and wind (16 variables in all; ~5 s, no login)
  * or, with radius_km=100/250, the land average of a 3 x 3 grid of points across that area
  * borrows GLDAS soil moisture/evaporation/runoff, GPM IMERG rain and MERRA-2 haze/dust (2000-2024) from the nearest of the
    360 analysed sites, because those come as global monthly files that take ~90 min to download (it says how far away it is)
  * runs the challenge's tests on every variable: trend per decade with Newey-West (HAC) t-test and 95% range, Mann-Kendall,
    Sen's slope, Benjamini-Hochberg across the place's variables; plus the deep statistics and disaster outlook from
    backend/intel/deep_stats.py (Bayesian, quantile regression, emergence, years needed, hazards, dry spells, aridity)
"""
from __future__ import annotations

import json
import logging
import math
import time
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import numpy as np
import requests
import statsmodels.api as sm
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from scipy import stats
from statsmodels.stats.multitest import multipletests

log = logging.getLogger("earthwatch")

from backend.intel import deep_stats as ds

# The live record is longer than the site archive: 1981-2024, baseline 1981-2002 vs 2003-2024 for extremes.
ds.START, ds.BASE_END = 1981, 2002
LIVE_START, LIVE_END = 1981, 2024
DATA = Path(os.environ.get('EARTHWATCH_DATA', Path(__file__).resolve().parents[2] / 'frontend' / 'public' / 'data'))
POWER = {'T2M': 'T2M', 'PRECTOTCORR': 'PRECTOTCORR', 'RH2M': 'RH2M', 'GWETTOP': 'GWETTOP'}
BORROWED = ['soil_moisture', 'evaporation', 'runoff', 'gpm_rain', 'aerosol', 'dust']
# Six more NASA POWER variables for the exact spot (asked for separately, so a problem with one never blocks the main four).
EXTRA = {
    'T2M_MAX': {'label': 'Hottest temperature of the month', 'unit': '°C', 'decimals': 2, 'family': 'air',
                'definition': 'The highest air temperature reached in each month.'},
    'T2M_MIN': {'label': 'Coldest temperature of the month', 'unit': '°C', 'decimals': 2, 'family': 'air',
                'definition': 'The lowest air temperature reached in each month (usually at night).'},
    'QV2M': {'label': 'Water vapour', 'unit': 'g/kg', 'decimals': 2, 'family': 'air',
             'definition': 'How much water vapour is in the air: grams of water per kilogram of air.'},
    'GWETROOT': {'label': 'Root-zone soil wetness', 'unit': '0–1', 'decimals': 3, 'family': 'land',
                 'definition': 'How wet the soil is where plant roots grow (top metre): 0 = bone dry, 1 = soaked.'},
    'ALLSKY_SFC_SW_DWN': {'label': 'Sunshine (solar energy)', 'unit': 'kWh/m²/day', 'decimals': 2, 'family': 'energy',
                          'definition': 'Sunlight reaching the ground, including cloudy days. Higher = more solar power.'},
    'WS50M': {'label': 'Wind speed at 50 m', 'unit': 'm/s', 'decimals': 2, 'family': 'energy',
              'definition': 'Average wind speed at wind-turbine height.'},
}
for v in EXTRA.values():
    v['source'] = 'NASA POWER (MERRA-2 / CERES)'

app = FastAPI(title='EARTHWATCH live analysis', version='1.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['GET'], allow_headers=['*'])


@lru_cache(maxsize=1)
def site_archive():
    regions = json.loads((DATA / 'regions.json').read_text())
    manifest = json.loads((DATA / 'manifest.json').read_text())
    series = {}
    for v in BORROWED:
        m = json.loads((DATA / 'monthly' / f'{v}.json').read_text())
        series[v] = np.array([[np.nan if x is None else x for x in row] for row in m['values']], dtype=float)
    return regions, {v['id']: v for v in manifest['variables']}, series


def km(lat1, lon1, lat2, lon2):
    r = math.radians
    a = math.sin(r(lat2 - lat1) / 2) ** 2 + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lon2 - lon1) / 2) ** 2
    return 2 * 6371 * math.asin(min(1, math.sqrt(a)))


@lru_cache(maxsize=2048)
def _power_request(lat: float, lon: float, params: tuple):
    last = None
    for attempt in range(3):
        try:
            r = requests.get('https://power.larc.nasa.gov/api/temporal/monthly/point', timeout=(10, 40), params={
                'parameters': ','.join(params), 'community': 'AG', 'latitude': lat, 'longitude': lon,
                'start': LIVE_START, 'end': LIVE_END, 'format': 'JSON'})
            r.raise_for_status()
            p = r.json()['properties']['parameter']
            out = {}
            for v in params:
                vals = [p.get(v, {}).get(f'{y}{m:02d}', -999) for y in range(LIVE_START, LIVE_END + 1) for m in range(1, 13)]
                out[v] = np.array([np.nan if x is None or x == -999 else x for x in vals], dtype=float)
            if 'ALLSKY_SFC_SW_DWN' in out:
                out['ALLSKY_SFC_SW_DWN'] = out['ALLSKY_SFC_SW_DWN'] / 3.6     # MJ/m²/day -> kWh/m²/day
            return out
        except Exception as e:
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'NASA POWER did not answer ({type(last).__name__})')


def fetch_power(lat: float, lon: float):
    """The main four variables for one point (raises if NASA POWER is down) plus the six extras (skipped if they fail)."""
    la, lo = round(lat, 2), round(lon, 2)
    with ThreadPoolExecutor(2) as ex:                       # ask for both groups at once
        main_job, extra_job = ex.submit(_power_request, la, lo, tuple(POWER)), ex.submit(_power_request, la, lo, tuple(EXTRA))
        try:
            out = dict(main_job.result())
        except RuntimeError as e:
            raise HTTPException(502, f'{e}. Try again in a moment.')
        try:
            out.update(extra_job.result())
        except RuntimeError:
            pass
    return {k: fill_gaps(v) for k, v in out.items()}


def fill_gaps(x):
    """NASA leaves some months empty (-999) in places with fewer weather stations and satellites passes.
    A year missing 1-3 months is completed with that calendar month's normal + the year's own anomaly,
    so the yearly tests (Mann-Kendall, aridity, hazards) can still use it. Years missing more stay empty."""
    x = np.asarray(x, float).copy()
    m = x.reshape(-1, 12)
    clim = np.nanmean(m, axis=0)
    anom = m - clim
    for y in range(len(m)):
        miss = ~np.isfinite(m[y])
        if 0 < miss.sum() <= 3 and np.isfinite(clim[miss]).all():
            m[y, miss] = clim[miss] + np.nanmean(anom[y])
    return m.ravel()


def fetch_area(lat: float, lon: float, radius_km: float):
    """Point (radius 0) or the land-only average of a 3 x 3 grid of points spread over +-radius_km."""
    if radius_km <= 0:
        return fetch_power(lat, lon), 1
    dlat = radius_km / 111.0
    dlon = radius_km / (111.0 * max(math.cos(math.radians(lat)), 0.2))
    pts = [(max(-89.9, min(89.9, lat + i * dlat)), ((lon + j * dlon + 180) % 360) - 180) for i in (-1, 0, 1) for j in (-1, 0, 1)]
    with ThreadPoolExecutor(9) as ex:
        results = list(ex.map(lambda p: _try_point(*p), pts))
    land = [r for r in results if r is not None and np.isfinite(r['GWETTOP']).sum() >= 300]
    if not land:
        raise HTTPException(422, 'No land data in this area (ocean or ice). Pick a spot on land.')
    keys = set.intersection(*(set(r) for r in land))
    w = np.array([math.cos(math.radians(p[0])) for p, r in zip(pts, results) if r is not None and np.isfinite(r['GWETTOP']).sum() >= 300])
    avg = {k: np.nansum([wi * r[k] for wi, r in zip(w, land)], axis=0) / np.nansum([wi * np.isfinite(r[k]) for wi, r in zip(w, land)], axis=0) for k in keys}
    return avg, len(land)


def _try_point(lat, lon):
    try:
        return fetch_power(lat, lon)
    except HTTPException:
        return None


def hac_trend(x, start):
    """Same test as the site's archive: monthly values with month dummies, OLS slope per decade, Newey-West HAC(12)."""
    ok = np.isfinite(x)
    if ok.sum() < 120 or np.nanstd(x) == 0:
        return None
    t = np.arange(len(x)) / 120.0
    month = np.arange(len(x)) % 12
    X = np.column_stack([t, *(month == k for k in range(12))]).astype(float)[ok]
    fit = sm.OLS(x[ok], X).fit(cov_type='HAC', cov_kwds={'maxlags': 12})
    lo, hi = fit.conf_int()[0]
    return {'slope': float(fit.params[0]), 'p': float(fit.pvalues[0]), 'ci': [float(lo), float(hi)], 'months': int(ok.sum()),
            'first_year': int(start + np.argmax(ok) // 12), 'last_year': int(start + (len(x) - 1 - np.argmax(ok[::-1])) // 12)}


def mann_kendall(x, start):
    """Mann-Kendall on yearly means (the challenge's suggested test) + Sen's slope per decade."""
    m = x.reshape(-1, 12)
    ok = np.isfinite(m).sum(1) == 12
    y = m[ok].mean(1)
    yrs = np.arange(start, start + len(m))[ok]
    if len(y) < 10 or np.std(y) == 0:
        return None
    tau, p = stats.kendalltau(yrs, y)
    return {'tau': float(tau), 'p': float(p), 'sen': float(stats.theilslopes(y, yrs).slope * 10)}


def _safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:                       # logged, then that piece is shown as "not enough data"
        log.warning('%s failed: %s: %s', getattr(fn, '__name__', fn), type(e).__name__, e)
        return None


def num(x, default):
    """A p-value / ratio that may be None or NaN (too few events) -> a safe number."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return default
    return x if np.isfinite(x) else default


def analyse_series(x, start, source):
    return {'source': source, 'trend': _safe(hac_trend, x, start), 'mk': _safe(mann_kendall, x, start),
            'deep': _safe(ds.series_stats, x, start)}


EMPTY_HAZARD = {'before': None, 'after': None, 'ratio': 1.0, 'p': 1.0, 'now': None, 'base': None}


def clean(o):
    if isinstance(o, dict):
        return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return None if not np.isfinite(o) else round(float(o), 5)
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


@app.get('/api/health')
def health():
    regions, _, _ = site_archive()
    return {'ok': True, 'sites': len(regions), 'live_period': [LIVE_START, LIVE_END]}


@app.get('/api/place')
def place(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180), label: str | None = None,
          radius_km: float = Query(0, ge=0, le=300)):
    regions, variables, series = site_archive()
    lat, lon = round(lat, 2), round(lon, 2)
    near = min(range(len(regions)), key=lambda i: km(lat, lon, regions[i]['lat'], regions[i]['lon']))
    near_km = km(lat, lon, regions[near]['lat'], regions[near]['lon'])
    live, n_points = fetch_area(lat, lon, radius_km)
    if np.isfinite(live['GWETTOP']).sum() < 300:
        raise HTTPException(422, 'NASA has no land data here (ocean or ice). Pick a spot on land.')
    where = 'this exact spot' if radius_km <= 0 else f'average of {n_points} points within {radius_km:.0f} km'

    out_vars = {v: analyse_series(live[v], LIVE_START, f'NASA POWER (MERRA-2), {where}') for v in POWER}
    for v in EXTRA:
        if v in live and np.isfinite(live[v]).sum() >= 120:
            out_vars[v] = analyse_series(live[v], LIVE_START, f'NASA POWER, {where}')
    src = f"nearest analysed site: {regions[near]['name']} ({near_km:.0f} km)"
    for v in BORROWED:
        if np.isfinite(series[v][near]).sum() >= 120:
            out_vars[v] = analyse_series(series[v][near], 2000, f'{variables[v]["source"]}, {src}')

    # Benjamini-Hochberg across this place's variables, then the same verdict words as the site
    names = [v for v in out_vars if out_vars[v]['trend']]
    q = multipletests([num(out_vars[v]['trend']['p'], 1.0) for v in names], method='fdr_bh')[1] if names else []
    for v, qq in zip(names, q):
        t, mk = out_vars[v]['trend'], out_vars[v]['mk']
        t['q'] = float(qq)
        mk_p = num(mk['p'], 1.0) if mk else 1.0
        both = qq < 0.05 and mk_p < 0.05
        t['verdict'] = 'significant' if both else 'suggestive' if (qq < 0.05 or num(t['p'], 1.0) < 0.05 or mk_p < 0.05) else 'not_significant'

    T, P, RH, W = live['T2M'], live['PRECTOTCORR'], live['RH2M'], live['GWETTOP']
    flags = {'heat': _safe(ds.extreme_flags, T, 0.9), 'drought': _safe(ds.extreme_flags, W, 0.1, False),
             'flood': _safe(lambda: ds.extreme_flags(P, 0.9, floor=0.5)),
             'fire': _safe(lambda: ds.extreme_flags(T, 0.75) * ds.extreme_flags(RH, 0.25, upper=False))}
    hazards = {h: (_safe(ds.freq_trend, flags[h]) if flags[h] is not None else None) or dict(EMPTY_HAZARD) for h in ds.HAZARDS}
    hq = multipletests([num(hazards[h]['p'], 1.0) for h in ds.HAZARDS], method='fdr_bh')[1]
    for h, qq in zip(ds.HAZARDS, hq):
        z = hazards[h]
        z['q'] = float(qq)
        ratio, p = num(z['ratio'], 1.0), num(z['p'], 1.0)
        z['verdict'] = ('rising' if ratio > 1 and qq < 0.05 else 'watch' if ratio > 1 and p < 0.2
                        else 'falling' if ratio < 1 and qq < 0.05 else 'steady')
    return clean({
        'place': {'label': label or f'{lat:.2f}, {lon:.2f}', 'lat': lat, 'lon': lon},
        'nearest_site': {'index': near, 'name': regions[near]['name'], 'km': near_km},
        'area': {'radius_km': radius_km, 'points': n_points},
        'meta': {**{k: {kk: variables[k][kk] for kk in ('label', 'unit', 'decimals', 'source', 'definition', 'family')} for k in list(POWER) + BORROWED}, **EXTRA},
        'period': [LIVE_START, LIVE_END], 'baseline': [LIVE_START, ds.BASE_END], 'recent': [ds.BASE_END + 1, LIVE_END],
        'variables': out_vars,
        'series': {v: {'start': LIVE_START if v not in BORROWED else 2000,
                       'values': [None if not np.isfinite(x) else round(float(x), 4) for x in (series[v][near] if v in BORROWED else live[v])]}
                   for v in out_vars},
        'outlook': {'hazards': hazards, 'hazards_rising': sum(hazards[h]['verdict'] == 'rising' for h in ds.HAZARDS),
                    'dry_spells': _safe(ds.dry_spells, P), 'aridity': _safe(ds.aridity, T, P, lat)},
    })
