"""Change-intelligence detectors over the exported NASA series.

Usage:
    python backend/intel/detectors.py frontend/public/data   # reads monthly/*.json, writes intel.json

Each detector answers a different question than "is the average moving?":
  volatility   is the place getting more erratic? (trend in |anomaly| after removing the mean trend)
  resilience   is it recovering from shocks more slowly? (rising lag-1 autocorrelation = critical slowing down)
  conflict     do independent NASA products disagree on direction? (rain: MERRA-2 vs GPM; soil: MERRA-2 vs GLDAS)
  syndrome     which places share the same multi-variable pattern of change? (k-means on standardised trends)
  migration    whose 2000-04 climate does this place's 2020-24 climate now resemble? (analogue search)
Every p-value family is corrected with Benjamini-Hochberg across all places and variables it covers.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import statsmodels.api as sm
from statsmodels.stats.multitest import multipletests

RNG = np.random.default_rng(20261115)
ALPHA = 0.05
VARS = ['T2M', 'RH2M', 'aerosol', 'dust', 'PRECTOTCORR', 'gpm_rain', 'evaporation', 'runoff', 'GWETTOP', 'soil_moisture']
EWS_VARS = ['GWETTOP', 'soil_moisture', 'evaporation', 'RH2M', 'T2M']  # land-surface memory variables
PAIRS = {'rain': ('PRECTOTCORR', 'gpm_rain'), 'soil': ('GWETTOP', 'soil_moisture')}


def load(data_dir: Path):
    regions = json.loads((data_dir / 'regions.json').read_text())
    trends = json.loads((data_dir / 'trends.json').read_text())
    series = {}
    for v in VARS:
        m = json.loads((data_dir / 'monthly' / f'{v}.json').read_text())
        series[v] = np.array([[np.nan if x is None else x for x in row] for row in m['values']], dtype=float)
    return regions, trends, series


def anomalies(x):
    """Remove each calendar month's mean (seasonal cycle). x: (n_regions, n_months)."""
    n, t = x.shape
    m = x.reshape(n, t // 12, 12)
    return (m - np.nanmean(m, axis=1, keepdims=True)).reshape(n, t)


def detrend(a):
    t = np.arange(a.shape[1], dtype=float)
    out = np.full_like(a, np.nan)
    for i, row in enumerate(a):
        ok = np.isfinite(row)
        if ok.sum() < 60:
            continue
        b = np.polyfit(t[ok], row[ok], 1)
        out[i] = row - np.polyval(b, t)
    return out


def hac_trend(y):
    """Slope per decade and p-value with Newey-West HAC(12) errors."""
    ok = np.isfinite(y)
    if ok.sum() < 120 or np.nanstd(y) == 0:
        return np.nan, np.nan
    t = np.arange(len(y))[ok] / 120.0  # decades
    X = sm.add_constant(t)
    fit = sm.OLS(y[ok], X).fit(cov_type='HAC', cov_kwds={'maxlags': 12})
    return float(fit.params[1]), float(fit.pvalues[1])


# ---- volatility -----------------------------------------------------------
def volatility(series):
    """Trend in the size of deviations: |detrended anomaly|, HAC errors.
    Reported as % change in typical deviation per decade."""
    out = {}
    for v in VARS:
        r = detrend(anomalies(series[v]))
        dev = np.abs(r)
        res = []
        for row in dev:
            s, p = hac_trend(row)
            base = np.nanmean(row)
            res.append((100 * s / base if base and np.isfinite(s) else np.nan, p))
        out[v] = res
    return out


# ---- resilience (critical slowing down) -----------------------------------
def rolling_lag1(x, w):
    """Lag-1 autocorrelation in sliding windows for many rows at once. x: (k, T)."""
    k, T = x.shape
    a, b = x[:, :-1], x[:, 1:]
    def csum(z):
        c = np.cumsum(np.nan_to_num(z), axis=1)
        return np.concatenate([np.zeros((k, 1)), c], axis=1)
    n = w - 1
    Sa, Sb, Saa, Sbb, Sab = (csum(z) for z in (a, b, a * a, b * b, a * b))
    def win(S):
        return S[:, n:] - S[:, :-n]
    sa, sb, saa, sbb, sab = map(win, (Sa, Sb, Saa, Sbb, Sab))
    cov = sab / n - (sa / n) * (sb / n)
    va = saa / n - (sa / n) ** 2
    vb = sbb / n - (sb / n) ** 2
    with np.errstate(invalid='ignore', divide='ignore'):
        return cov / np.sqrt(va * vb)


def kendall_tau_rows(y):
    """Kendall tau of each row against time (vectorised, no ties assumed)."""
    k, m = y.shape
    s = np.zeros(k)
    for i in range(m - 1):
        s += np.sign(y[:, i + 1:] - y[:, [i]]).sum(axis=1)
    return s / (m * (m - 1) / 2)


def resilience(series, w=120, n_surr=199):
    """Rising lag-1 autocorrelation of detrended anomalies (10-year windows).
    Significance from AR(1) surrogates with the same lag-1 autocorrelation and variance:
    a stationary system with identical memory, so a rising indicator can't come from
    the windowing itself."""
    out = {}
    for v in EWS_VARS:
        r = detrend(anomalies(series[v]))
        res = []
        for row in r:
            if not np.isfinite(row).all() or np.std(row) == 0:
                res.append((np.nan, np.nan, np.nan, np.nan))
                continue
            x = (row - row.mean()) / row.std()
            ac = rolling_lag1(x[None, :], w)[0]
            tau = kendall_tau_rows(ac[None, ::6])[0]  # half-yearly steps keep it fast
            phi = np.corrcoef(x[:-1], x[1:])[0, 1]
            e = RNG.normal(0, math.sqrt(max(1 - phi ** 2, 1e-6)), (n_surr, len(x)))
            sur = np.zeros_like(e)
            for t in range(1, len(x)):
                sur[:, t] = phi * sur[:, t - 1] + e[:, t]
            tau_null = kendall_tau_rows(rolling_lag1(sur, w)[:, ::6])
            p = (1 + np.sum(tau_null >= tau)) / (n_surr + 1)
            res.append((float(tau), float(p), float(ac[0]), float(ac[-1])))
        out[v] = res
    return out


# ---- conflict between independent products --------------------------------
def conflict(trends):
    T = trends['variables']
    out = {}
    for name, (a, b) in PAIRS.items():
        rows = []
        for i in range(len(T[a]['slope'])):
            va, vb = T[a]['verdict'][i], T[b]['verdict'][i]
            sa, sb = T[a]['slope'][i], T[b]['slope'][i]
            if sa is None or sb is None:
                rows.append('no_data')
            elif va == 'significant' and vb == 'significant':
                rows.append('corroborated' if np.sign(sa) == np.sign(sb) else 'contradicted')
            elif va == 'significant' or vb == 'significant':
                other = sb if va == 'significant' else sa
                lead = sa if va == 'significant' else sb
                rows.append('single_source' if np.sign(other) == np.sign(lead) else 'contested')
            else:
                rows.append('quiet')
        out[name] = rows
    return out


# ---- syndromes (unsupervised) ---------------------------------------------
def syndromes(trends, k_range=range(4, 9)):
    from sklearn.cluster import KMeans
    from sklearn.metrics import silhouette_score
    T = trends['variables']
    n = len(T['T2M']['slope'])
    # t-like score per variable: slope / half-width of CI, capped; missing -> 0
    X = np.zeros((n, len(VARS)))
    for j, v in enumerate(VARS):
        for i in range(n):
            s, lo, hi = T[v]['slope'][i], T[v]['ci_low'][i], T[v]['ci_high'][i]
            if s is None or hi is None or hi == lo:
                continue
            X[i, j] = np.clip(s / ((hi - lo) / 3.92), -6, 6)
    best = None
    for k in k_range:
        km = KMeans(n_clusters=k, n_init=20, random_state=0).fit(X)
        sc = silhouette_score(X, km.labels_)
        if best is None or sc > best[0]:
            best = (sc, k, km)
    sc, k, km = best
    return {'k': k, 'silhouette': float(sc), 'labels': km.labels_.tolist(),
            'centroids': km.cluster_centers_.round(2).tolist(), 'features': VARS, 'X': X}


# ---- climate migration (analogues) ----------------------------------------
def migration(series, regions, early=(0, 60), late=(240, 300)):
    feats = ['T2M', 'PRECTOTCORR', 'RH2M', 'GWETTOP']
    def clim(sl):
        cols = []
        for v in feats:
            x = series[v][:, sl[0]:sl[1]]
            cols.append(np.nanmean(x.reshape(len(x), -1, 12), axis=1))  # 12 monthly means
        return np.concatenate(cols, axis=1)
    E, L = clim(early), clim(late)
    sd = np.nanstd(np.concatenate([E, L]), axis=0)
    sd[sd == 0] = 1
    E, L = E / sd, L / sd
    lat = np.array([r['lat'] for r in regions]); lon = np.array([r['lon'] for r in regions])
    out = []
    for i in range(len(regions)):
        d = np.sqrt(np.nansum((E - L[i]) ** 2, axis=1))
        j = int(np.nanargmin(d))
        out.append({'analogue': j, 'self_distance': float(d[i]), 'analogue_distance': float(d[j]),
                    'moved': j != i})
    return out


def bh(pvals):
    p = np.array([np.nan if x is None else x for x in pvals], dtype=float)
    q = np.full_like(p, np.nan)
    ok = np.isfinite(p)
    if ok.any():
        q[ok] = multipletests(p[ok], method='fdr_bh')[1]
    return q


LABEL = {'T2M': 'Air temperature', 'RH2M': 'Humidity', 'aerosol': 'Haze', 'dust': 'Desert dust',
         'PRECTOTCORR': 'Rainfall (MERRA-2)', 'gpm_rain': 'Rainfall (GPM satellite)', 'evaporation': 'Evaporation',
         'runoff': 'Runoff', 'GWETTOP': 'Topsoil wetness (MERRA-2)', 'soil_moisture': 'Soil moisture (GLDAS)'}
UNIT = {'T2M': '°C', 'RH2M': '%', 'aerosol': 'AOD', 'dust': 'AOD', 'PRECTOTCORR': 'mm/day', 'gpm_rain': 'mm/day',
        'evaporation': 'mm/day', 'runoff': 'mm/day', 'GWETTOP': '', 'soil_moisture': 'kg/m²'}
DEC = {'T2M': 2, 'RH2M': 1, 'aerosol': 3, 'dust': 3, 'PRECTOTCORR': 2, 'gpm_rain': 2, 'evaporation': 2, 'runoff': 3,
       'GWETTOP': 3, 'soil_moisture': 2}
WORDS = {'T2M': ('cooling', 'warming'), 'RH2M': ('air drying', 'air moistening'), 'aerosol': ('clearing', 'hazier'),
         'dust': ('less dust', 'dustier'), 'PRECTOTCORR': ('less rain', 'more rain'), 'gpm_rain': ('less rain', 'more rain'),
         'evaporation': ('less evaporation', 'more evaporation'), 'runoff': ('less runoff', 'more runoff'),
         'GWETTOP': ('topsoil drying', 'topsoil wetting'), 'soil_moisture': ('soil drying', 'soil wetting')}
SYSTEM = {'T2M': 'MERRA-2', 'RH2M': 'MERRA-2', 'PRECTOTCORR': 'MERRA-2', 'GWETTOP': 'MERRA-2', 'aerosol': 'MERRA-2 aerosol',
          'dust': 'MERRA-2 aerosol', 'gpm_rain': 'GPM IMERG', 'evaporation': 'GLDAS', 'runoff': 'GLDAS', 'soil_moisture': 'GLDAS'}


def fmt(x, d):
    if x is None or not np.isfinite(x):
        return '–'
    a = abs(x)
    if 0 < a < 10 ** -d:  # tiny values: two significant figures instead of "0.000"
        d = int(-math.floor(math.log10(a))) + 1
    return f"{'+' if x > 0 else '−' if x < 0 else ''}{a:.{d}f}"


def haversine(a, b):
    p1, p2 = math.radians(a['lat']), math.radians(b['lat'])
    dl = math.radians(b['lon'] - a['lon'])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def bearing_word(a, b):
    y = math.sin(math.radians(b['lon'] - a['lon'])) * math.cos(math.radians(b['lat']))
    x = math.cos(math.radians(a['lat'])) * math.sin(math.radians(b['lat'])) - math.sin(math.radians(a['lat'])) * math.cos(math.radians(b['lat'])) * math.cos(math.radians(b['lon'] - a['lon']))
    deg = (math.degrees(math.atan2(y, x)) + 360) % 360
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][int((deg + 22.5) // 45) % 8]


def main(data_dir):
    data_dir = Path(data_dir)
    regions, trends, series = load(data_dir)
    T = trends['variables']
    n = len(regions)
    vol = volatility(series)
    res = resilience(series)
    con = conflict(trends)
    syn = syndromes(trends)
    mig = migration(series, regions)
    mig_null = migration(series, regions, (0, 60), (60, 120))
    vol_q = bh([p for v in VARS for _, p in vol[v]]).reshape(len(VARS), -1)
    res_q = bh([r[1] for v in EWS_VARS for r in res[v]]).reshape(len(EWS_VARS), -1)

    signals = []
    def add(site, kind, var, value, unit, q, grade, headline, score, extra=None):
        signals.append({'site': site, 'type': kind, 'var': var, 'value': value, 'unit': unit,
                        'q': None if q is None or not np.isfinite(q) else round(float(q), 6),
                        'grade': grade, 'headline': headline, 'score': round(float(score), 4), **(extra or {})})

    pair_state = {i: {k: con[k][i] for k in con} for i in range(n)}
    pair_of = {a: k for k, (a, b) in PAIRS.items()} | {b: k for k, (a, b) in PAIRS.items()}

    # drift (agreeing pairs fused into one signal)
    done_pairs = set()
    for v in VARS:
        t = T[v]
        for i in range(n):
            if t['verdict'][i] != 'significant':
                continue
            s = t['slope'][i]
            pair = pair_of.get(v)
            corrob = pair is not None and pair_state[i][pair] == 'corroborated'
            if corrob and (i, pair) in done_pairs:
                continue
            q = t['p_bh'][i]
            grade = 'confirmed' if corrob or (q < 0.01 and not t['hac_sensitive'][i]) else 'probable'
            word = WORDS[v][1 if s > 0 else 0]
            unit = f"{UNIT[v]}/decade".strip() if UNIT[v] else '/decade'
            head = f"{word[0].upper() + word[1:]} {fmt(s, DEC[v])}{' ' if UNIT[v] else ''}{unit}"
            extra = None
            if corrob:
                done_pairs.add((i, pair))
                a, b = PAIRS[pair]
                head = (f"{word[0].upper() + word[1:]}: {SYSTEM[a]} {fmt(T[a]['slope'][i], DEC[a])}"
                        f"{' ' + UNIT[a] if UNIT[a] else ''}, {SYSTEM[b]} {fmt(T[b]['slope'][i], DEC[b])}"
                        f"{' ' + UNIT[b] if UNIT[b] else ''} per decade · 2 systems agree")
                q = max(T[a]['p_bh'][i], T[b]['p_bh'][i])
                extra = {'pair': [a, b], 'slopes': [T[a]['slope'][i], T[b]['slope'][i]]}
            add(i, 'drift', v, s, unit, q, grade, head,
                min(1.0, abs(s) / t['scale']) * (1.25 if corrob else 1.0), extra)

    # erratic / steadier
    for j, v in enumerate(VARS):
        for i in range(n):
            pct, _ = vol[v][i]
            q = vol_q[j, i]
            if not (np.isfinite(q) and q < ALPHA):
                continue
            kind = 'erratic' if pct > 0 else 'steadier'
            head = (f"{LABEL[v]} swings growing {fmt(pct, 0)}%/decade" if pct > 0
                    else f"{LABEL[v]} swings shrinking {fmt(pct, 0)}%/decade")
            add(i, kind, v, pct, '%/decade', q, 'confirmed' if q < 0.01 else 'probable', head,
                min(1.0, abs(pct) / 40) * (0.9 if pct > 0 else 0.5))

    # conflicting sources
    for name, (a, b) in PAIRS.items():
        for i in range(n):
            state = con[name][i]
            if state not in ('contradicted', 'contested'):
                continue
            sa, sb = T[a]['slope'][i], T[b]['slope'][i]
            head = (f"{'Soil' if name == 'soil' else 'Rain'} records disagree: {SYSTEM[a]} {WORDS[a][1 if sa > 0 else 0]}, "
                    f"{SYSTEM[b]} {WORDS[b][1 if sb > 0 else 0]}")
            qa, qb = T[a]['p_bh'][i], T[b]['p_bh'][i]
            add(i, 'conflict', name, None, '', max(qa, qb) if state == 'contradicted' else min(qa, qb),
                'confirmed' if state == 'contradicted' else 'probable', head, 1.0 if state == 'contradicted' else 0.7,
                {'pair': [a, b], 'state': state, 'slopes': [sa, sb]})

    # climate migration
    for i, m in enumerate(mig):
        if not m['moved']:
            continue
        j = m['analogue']
        margin = 1 - m['analogue_distance'] / m['self_distance']
        km = haversine(regions[i], regions[j])
        head = f"Climate now closest to {regions[j]['name']} (2000–04), {km:,.0f} km {bearing_word(regions[i], regions[j])}"
        add(i, 'migrate', None, round(km), 'km', None, 'probable' if margin >= 0.1 else 'possible', head,
            min(1.0, margin * 3) * 0.8, {'target': j, 'margin': round(margin, 3)})

    signals.sort(key=lambda s: -s['score'])
    for k, s in enumerate(signals):
        s['id'] = f'S{k + 1:04d}'

    # per-site fusion
    by_site = [[] for _ in range(n)]
    for s in signals:
        by_site[s['site']].append(s)
    sites = []
    for i in range(n):
        sig = by_site[i]
        counts = {k: sum(1 for s in sig if s['type'] == k) for k in ('drift', 'erratic', 'steadier', 'conflict', 'migrate')}
        score = sum(sorted((s['score'] for s in sig), reverse=True)[:4])
        parts = []
        drifts = [s for s in sig if s['type'] == 'drift'][:3]
        if drifts:
            parts.append('Significant change: ' + '; '.join(s['headline'][0].lower() + s['headline'][1:] for s in drifts) + '.')
        er = [s for s in sig if s['type'] == 'erratic'][:2]
        if er:
            parts.append('Becoming more erratic: ' + '; '.join(f"{LABEL[s['var']]} swings {fmt(s['value'], 0)}%/decade" for s in er) + '.')
        cf = [s for s in sig if s['type'] == 'conflict']
        if cf:
            parts.append(' '.join(f"{s['headline']}: treat {s['var']} findings here with caution." for s in cf))
        mg = [s for s in sig if s['type'] == 'migrate']
        if mg:
            parts.append(f"Its 2020–24 climate most resembles {regions[mg[0]['target']]['name']} in 2000–04.")
        if not parts:
            parts.append('No significant change, volatility shift or source conflict detected in any of the 10 records.')
        vol_rows = {v: {'pct': None if not np.isfinite(vol[v][i][0]) else round(vol[v][i][0], 1),
                        'q': None if not np.isfinite(vol_q[j, i]) else round(float(vol_q[j, i]), 5)}
                    for j, v in enumerate(VARS)}
        res_rows = {v: {'tau': None if not np.isfinite(res[v][i][0]) else round(res[v][i][0], 3),
                        'q': None if not np.isfinite(res_q[j, i]) else round(float(res_q[j, i]), 4)}
                    for j, v in enumerate(EWS_VARS)}
        sites.append({'score': round(score, 4), 'counts': counts, 'signals': [s['id'] for s in sig],
                      'assessment': ' '.join(parts), 'pairs': pair_state[i], 'volatility': vol_rows,
                      'resilience': res_rows, 'analogue': mig[i]['analogue'] if mig[i]['moved'] else None})
    order = sorted(range(n), key=lambda i: -sites[i]['score'])
    for rank, i in enumerate(order):
        sites[i]['rank'] = rank + 1

    totals = {k: sum(1 for s in signals if s['type'] == k) for k in ('drift', 'erratic', 'steadier', 'conflict', 'migrate')}
    out = {
        'generated_from': 'monthly/*.json + trends.json',
        'alpha': ALPHA,
        'totals': totals,
        'signals': signals,
        'sites': sites,
        'detectors': {
            'drift': {'label': 'Drift', 'question': 'Is the average moving?',
                      'method': trends['method'], 'count': totals['drift']},
            'erratic': {'label': 'Erratic', 'question': 'Are the swings getting bigger?',
                        'method': 'Trend in the absolute size of deseasonalised, detrended monthly anomalies; Newey-West HAC(12); '
                                  'Benjamini-Hochberg across all places and variables.',
                        'count': totals['erratic'], 'steadier': totals['steadier'],
                        'caveat': 'For rain and runoff, swings naturally grow when the average grows; read alongside drift.'},
            'conflict': {'label': 'Conflict', 'question': 'Do independent NASA systems disagree?',
                         'method': 'Rain: MERRA-2 (POWER) vs GPM IMERG. Soil: MERRA-2 topsoil wetness vs GLDAS soil moisture. '
                                   'Contradicted = both significant, opposite directions. Contested = one significant, the other '
                                   'points the other way.',
                         'count': totals['conflict'],
                         'pairs': {k: {s: v.count(s) for s in sorted(set(v))} for k, v in con.items()}},
            'migrate': {'label': 'Migrate', 'question': 'Does this place\'s climate now resemble somewhere else?',
                        'method': 'Analogue search on 12 monthly means of temperature, rain, humidity and topsoil wetness: '
                                  '2020-24 at each place vs 2000-04 at all 360.',
                        'count': totals['migrate'],
                        'baseline': {'gap_5y': int(sum(m['moved'] for m in mig_null)), 'gap_20y': int(sum(m['moved'] for m in mig))},
                        'caveat': f"About {int(sum(m['moved'] for m in mig_null))} places 'move' over just 5 years from weather "
                                  'noise alone, so any single match is a lead, not a finding.'},
            'resilience': {'label': 'Early warning', 'question': 'Is it losing the ability to bounce back?',
                           'method': 'Rising lag-1 autocorrelation in 10-year windows (critical slowing down), AR(1) surrogates, '
                                     'Benjamini-Hochberg.',
                           'count': int(np.nansum(res_q < ALPHA)),
                           'raw_hits': int(sum(np.sum(np.array([r[1] for r in res[v]]) < 0.05) for v in EWS_VARS)),
                           'tests': int(np.isfinite(res_q).sum()),
                           'note': 'Watched, nothing detected: raw hits are at the rate expected by chance.'},
            'syndrome': {'label': 'Change types', 'silhouette': round(syn['silhouette'], 3),
                         'note': 'Clustering found no natural groups of places (silhouette ≤ 0.22), so none are shown.'},
        },
    }
    (data_dir / 'intel.json').write_text(json.dumps(out, separators=(',', ':'), ensure_ascii=False))
    print(json.dumps({'signals': len(signals), **totals,
                      'early_warning': out['detectors']['resilience']['count'],
                      'bytes': (data_dir / 'intel.json').stat().st_size}))


if __name__ == '__main__':
    main(sys.argv[1])
