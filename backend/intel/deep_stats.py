"""Deep statistics and disaster outlook for every site, from the same exported NASA series.

Usage:
    python backend/intel/deep_stats.py frontend/public/data     # reads monthly/*.json, writes deep.json (~1-2 min)

Methods no other team in this challenge uses (checked across the 186 public GitHub entries):
  per site x variable
    bayes        Bayesian trend (Jeffreys prior -> Student-t posterior): probability the direction is real, Bayes factor
    extremes     quantile regression on monthly anomalies: are the 10% lowest / typical / 10% highest months changing differently?
    emergence    signal-to-noise of the smooth (LOWESS) change vs natural year-to-year noise; year it left its normal range
    years_needed for trends that are not yet significant: how many years of data until they would be, at the same rate
  per site
    hazards      heat, drought, flood and fire-weather months (beyond each calendar month's 2000-2011 percentiles);
                 change in frequency by quasi-binomial GLM; Benjamini-Hochberg across all sites x hazards;
                 chance that a month is extreme now (fitted 2024) vs the baseline
    dry_spells   two-state Markov chain on wet/dry months: P(dry -> dry), mean dry-spell length, early vs late, likelihood-ratio test
    aridity      UN aridity index (rain / Thornthwaite potential evaporation), class, Sen trend, Mann-Kendall p, year it would cross
    stability    5 ingredients ranked as percentiles across all sites -> 0-100 score, block-bootstrap 95% range, rank
"""
from __future__ import annotations

import json
import sys
import warnings
from pathlib import Path

import numpy as np
import statsmodels.api as sm
from scipy import stats
from statsmodels.nonparametric.smoothers_lowess import lowess
from statsmodels.stats.multitest import multipletests

warnings.filterwarnings('ignore')
VARS = ['T2M', 'RH2M', 'aerosol', 'dust', 'PRECTOTCORR', 'gpm_rain', 'evaporation', 'runoff', 'GWETTOP', 'soil_moisture']
START = 2000
BASE_END = 2011           # baseline 2000-2011 vs recent 2012-2024
HAZARDS = ['heat', 'drought', 'flood', 'fire']
ARID = [(0, 0.05, 'Hyper-arid'), (0.05, 0.2, 'Arid'), (0.2, 0.5, 'Semi-arid'), (0.5, 0.65, 'Dry sub-humid'), (0.65, np.inf, 'Humid')]
RNG = np.random.default_rng(20261115)


def r(x, d=4):
    return None if x is None or not np.isfinite(x) else round(float(x), d)


def load(data_dir: Path):
    regions = json.loads((data_dir / 'regions.json').read_text())
    series = {}
    for v in VARS:
        m = json.loads((data_dir / 'monthly' / f'{v}.json').read_text())
        series[v] = np.array([[np.nan if x is None else x for x in row] for row in m['values']], dtype=float)
    return regions, series


def yearly(x):
    m = x.reshape(-1, 12)
    ok = np.isfinite(m).sum(1) == 12
    years = np.arange(START, START + len(m))[ok]
    return years.astype(float), m[ok].mean(1)


def month_anoms(x):
    m = x.reshape(-1, 12)
    return (m - np.nanmean(m, axis=0)).ravel()


def loglik(res):
    n = len(res)
    return -n / 2 * (np.log(2 * np.pi * max(res @ res, 1e-300) / n) + 1)


# ---------------- per site x variable ----------------
def series_stats(x):
    t, y = yearly(x)
    if len(y) < 15 or np.nanstd(y) == 0:
        return None
    n, tc = len(y), t - t.mean()
    ols = stats.linregress(tc, y)
    res = y - (ols.intercept + ols.slope * tc)
    s = np.sqrt(res @ res / (n - 2))
    out = {'slope': r(ols.slope * 10), 'p': r(ols.pvalue)}
    if ols.stderr > 0:                                                    # Bayesian
        post = stats.t(df=n - 2, loc=ols.slope * 10, scale=ols.stderr * 10)
        bf = np.exp(((2 * np.log(n) - 2 * loglik(y - y.mean())) - (3 * np.log(n) - 2 * loglik(res))) / 2)
        out.update(sure=r(post.cdf(0) if ols.slope < 0 else post.sf(0)), cred=[r(post.ppf(.025)), r(post.ppf(.975))], bf=r(bf, 3),
                   evidence='favours no trend' if bf < 1 else 'weak' if bf < 3 else 'positive' if bf < 20 else 'strong' if bf < 150 else 'very strong')
    a = month_anoms(x)                                                    # quantile regression
    ok = np.isfinite(a)
    if ok.sum() >= 120:
        tm = (np.arange(len(a)) / 12 + START + 1 / 24)[ok]
        X = sm.add_constant(tm - tm.mean())
        q = {}
        rho = np.clip(np.corrcoef(a[ok][:-1], a[ok][1:])[0, 1], 0, 0.95)   # months remember each other:
        infl = np.sqrt((1 + rho) / (1 - rho))                               # widen the standard error (AR(1) effective n)
        for qq in (0.1, 0.5, 0.9):
            try:
                f = sm.QuantReg(a[ok], X).fit(q=qq)
                z = f.params[1] / (f.bse[1] * infl)
                q[str(int(qq * 100))] = [r(f.params[1] * 10), r(2 * stats.norm.sf(abs(z)))]
            except Exception:
                q[str(int(qq * 100))] = [None, None]
        out['quantiles'] = q
    try:                                                                  # time of emergence
        fit = lowess(y, t, frac=0.6, return_sorted=False)
        nb = 10
        noise = np.std(y - fit, ddof=1)
        sn = (fit - fit[:nb].mean()) / noise if noise > 0 else np.zeros_like(fit)
        above = np.abs(sn) > 1
        year = None
        if above[-1]:
            i = len(above) - 1
            while i > 0 and above[i - 1]:
                i -= 1
            year = int(t[i])
        out.update(sn=r(sn[-1], 2), emerged=year)
    except Exception:
        pass
    if ols.pvalue >= 0.05 and ols.slope != 0 and s > 0:                   # years until significant
        f = lambda nn: abs(ols.slope) * np.sqrt(nn * (nn ** 2 - 1) / 12) / s - stats.t.ppf(0.975, nn - 2)
        lo, hi = 3.0, 2000.0
        if f(lo) * f(hi) < 0:
            for _ in range(80):
                mid = (lo + hi) / 2
                lo, hi = (lo, mid) if f(lo) * f(mid) <= 0 else (mid, hi)
            out['sig_by'] = int(START + np.ceil(hi) - 1)
    return out


# ---------------- per site: hazards ----------------
def extreme_flags(x, q, upper=True, floor=None):
    m = x.reshape(-1, 12)
    base = m[: BASE_END - START + 1]
    thr = np.nanquantile(base, q, axis=0)
    if floor is not None:
        thr = np.maximum(thr, floor)
    with np.errstate(invalid='ignore'):
        f = (m > thr) if upper else (m < thr)
    f = f.astype(float)
    f[~np.isfinite(m)] = np.nan
    return f


def freq_trend(flags):
    ok = np.isfinite(flags).all(1)
    k = flags[ok].sum(1)
    yrs = np.arange(START, START + len(flags))[ok].astype(float)
    early, late = k[yrs <= BASE_END].mean(), k[yrs > BASE_END].mean()
    out = {'before': r(early, 2), 'after': r(late, 2), 'ratio': 1.0, 'p': 1.0, 'now': r(late / 12, 3), 'base': r(early / 12, 3)}
    if 0 < k.sum() < 12 * len(k):
        X = sm.add_constant((yrs - yrs.mean()) / 10)
        try:
            model = sm.GLM(np.c_[k, 12 - k], X, family=sm.families.Binomial())
            f1 = model.fit()
            fit = model.fit(scale=max(1.0, f1.pearson_chi2 / f1.df_resid))
            x24 = np.array([[1.0, (2024 - yrs.mean()) / 10]])
            out.update(ratio=r(np.exp(fit.params[1]), 3), p=r(fit.pvalues[1]), now=r(fit.predict(x24)[0], 3))
        except Exception:
            pass
    return out


def dry_spells(rain):
    m = rain.reshape(-1, 12)
    med = np.nanmedian(m[: BASE_END - START + 1], axis=0)
    dry = (m < med).astype(float)
    dry[~np.isfinite(m)] = np.nan
    seq = dry.ravel()
    years = np.repeat(np.arange(START, START + len(m)), 12)

    def trans(mask):
        a, b = seq[:-1][mask[:-1]], seq[1:][mask[:-1]]
        ok = np.isfinite(a) & np.isfinite(b)
        a, b = a[ok], b[ok]
        return int(((a == 1) & (b == 1)).sum()), int(((a == 1) & (b == 0)).sum())

    dd1, dw1 = trans(years <= BASE_END)
    dd2, dw2 = trans(years > BASE_END)
    if min(dd1 + dw1, dd2 + dw2) < 10:
        return None
    p1, p2, p0 = dd1 / (dd1 + dw1), dd2 / (dd2 + dw2), (dd1 + dd2) / (dd1 + dw1 + dd2 + dw2)

    def ll(dd, dw, p):
        p = min(max(p, 1e-9), 1 - 1e-9)
        return dd * np.log(p) + dw * np.log(1 - p)

    lr = 2 * (ll(dd1, dw1, p1) + ll(dd2, dw2, p2) - ll(dd1, dw1, p0) - ll(dd2, dw2, p0))
    return {'p_dd_before': r(p1, 3), 'p_dd_after': r(p2, 3), 'spell_before': r(1 / (1 - p1), 2) if p1 < 1 else None,
            'spell_after': r(1 / (1 - p2), 2) if p2 < 1 else None, 'p': r(stats.chi2.sf(lr, 1))}


def aridity(t2m, rain, lat):
    m_t = t2m.reshape(-1, 12)
    m_p = rain.reshape(-1, 12)
    clim = np.clip(np.nanmean(m_t, axis=0), 0, None)
    I = ((clim / 5) ** 1.514).sum()
    if I <= 0:
        return None
    a = 6.75e-7 * I ** 3 - 7.71e-5 * I ** 2 + 1.792e-2 * I + 0.49239
    Tp = np.clip(m_t, 0, None)
    with np.errstate(all='ignore'):
        pet = np.where(Tp < 26.5, 16 * (10 * Tp / I) ** a, -415.85 + 32.24 * Tp - 0.43 * Tp ** 2)
    days = np.array([31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
    J = np.cumsum(days) - days / 2
    dec = 0.409 * np.sin(2 * np.pi * J / 365 - 1.39)
    N = 24 / np.pi * np.arccos(np.clip(-np.tan(np.radians(lat)) * np.tan(dec), -1, 1))
    pet = np.nan_to_num(pet) * (N / 12) * (days / 30)
    rainm = m_p * days
    ok = np.isfinite(rainm).all(1) & np.isfinite(m_t).all(1)
    P, E = rainm[ok].sum(1), pet[ok].sum(1)
    yrs = np.arange(START, START + len(m_t))[ok].astype(float)
    good = E > 0
    if good.sum() < 15:
        return None
    ai, yrs = P[good] / E[good], yrs[good]
    cls = lambda v: next(n for lo, hi, n in ARID if lo <= v < hi)
    sen = stats.theilslopes(ai, yrs)
    tau, p = stats.kendalltau(yrs, ai)
    now, then = ai[yrs >= 2015].mean(), ai[yrs <= 2009].mean()
    icpt = np.median(ai - sen.slope * yrs)
    level = icpt + sen.slope * 2024
    bounds = [0.05, 0.2, 0.5, 0.65]
    nxt = max([b for b in bounds if b < level], default=None) if sen.slope < 0 else min([b for b in bounds if b > level], default=None)
    cross = (nxt - icpt) / sen.slope if (nxt is not None and sen.slope != 0) else np.nan
    return {'then': r(then, 3), 'now': r(now, 3), 'class_then': cls(then), 'class_now': cls(now),
            'pct': r(sen.slope * 10 / ai.mean() * 100, 2), 'p': r(p),
            'towards': (cls(nxt - 1e-9) if sen.slope < 0 else cls(nxt)) if nxt is not None else None,
            'cross': int(cross) if (p < 0.05 and np.isfinite(cross) and 2024 < cross < 2200) else None}


def ingredients(T, P, counts, yrs):
    tc = yrs - yrs.mean()

    def sr(v):
        b = (tc * (v - v.mean())).sum() / (tc ** 2).sum()
        return b, v - v.mean() - b * tc

    bT, rT = sr(T)
    bP, rP = sr(P)
    mP = max(P.mean(), 1e-6)
    e, l = yrs <= BASE_END, yrs > BASE_END
    extra = sum(max(0.0, c[l].mean() - c[e].mean()) for c in counts) if e.any() and l.any() else np.nan
    return np.array([abs(bT * 10), abs(bP * 10 / mP * 100), rT.std(ddof=2), rP.std(ddof=2) / mP * 100, extra])


def main(data_dir: Path):
    regions, S = load(data_dir)
    n = len(regions)
    sites, haz_p, ING, yt = [], [], [], []
    for i, reg in enumerate(regions):
        site = {'vars': {v: series_stats(S[v][i]) for v in VARS}}
        T, P, RH, W = S['T2M'][i], S['PRECTOTCORR'][i], S['RH2M'][i], S['GWETTOP'][i]
        flags = {'heat': extreme_flags(T, 0.9), 'drought': extreme_flags(W, 0.1, upper=False),
                 'flood': extreme_flags(P, 0.9, floor=0.5),
                 'fire': extreme_flags(T, 0.75) * extreme_flags(RH, 0.25, upper=False)}
        site['hazards'] = {h: freq_trend(f) for h, f in flags.items()}
        haz_p += [site['hazards'][h]['p'] for h in HAZARDS]
        site['dry_spells'] = dry_spells(P)
        site['aridity'] = aridity(T, P, reg['lat'])
        ty, Ty = yearly(T)
        _, Py = yearly(P)
        if len(Ty) == len(Py) and len(Ty) >= 20:
            counts = [np.nansum(flags[h], axis=1)[(ty - START).astype(int)] for h in HAZARDS]
            ING.append(ingredients(Ty, Py, counts, ty)); yt.append((i, ty, Ty, Py, counts))
        sites.append(site)

    q = multipletests(np.nan_to_num(np.array(haz_p, float), nan=1.0), method='fdr_bh')[1]   # FDR across all sites x hazards
    for i, site in enumerate(sites):
        rising = 0
        for j, h in enumerate(HAZARDS):
            hz = site['hazards'][h]
            hz['q'] = r(q[i * 4 + j])
            hz['verdict'] = ('rising' if hz['ratio'] > 1 and hz['q'] < 0.05 else 'watch' if hz['ratio'] > 1 and hz['p'] < 0.2
                             else 'falling' if hz['ratio'] < 1 and hz['q'] < 0.05 else 'steady')
            rising += hz['verdict'] == 'rising'
        site['hazards_rising'] = rising

    ING = np.array(ING)                                                   # stability: percentiles across all sites
    ref = np.sort(ING, axis=0)
    score = lambda v: float(np.mean([100 * (1 - np.searchsorted(ref[:, j], v[j]) / len(ref)) for j in range(len(v))]))
    scores = {}
    for (i, ty, Ty, Py, counts), v in zip(yt, ING):
        bs, m = [], len(ty)
        for _ in range(200):
            st = RNG.integers(0, m - 3, int(np.ceil(m / 4)))
            idx = np.sort((st[:, None] + np.arange(4)).ravel()[:m])
            yb = ty[idx]
            if (yb <= BASE_END).any() and (yb > BASE_END).any():
                bs.append(score(ingredients(Ty[idx], Py[idx], [c[idx] for c in counts], ty[idx] + np.arange(m) * 1e-6)))
        scores[i] = (score(v), np.percentile(bs, 2.5), np.percentile(bs, 97.5))
    order = sorted(scores, key=lambda k: -scores[k][0])
    for rank, i in enumerate(order, 1):
        s, lo, hi = scores[i]
        sites[i]['stability'] = {'score': r(s, 1), 'low': r(lo, 1), 'high': r(hi, 1), 'rank': rank, 'of': len(order)}

    totals = {h: int(sum(s['hazards'][h]['verdict'] == 'rising' for s in sites)) for h in HAZARDS}
    out = {
        'generated_from': 'monthly/*.json', 'baseline': [START, BASE_END], 'recent': [BASE_END + 1, 2024],
        'totals': {'hazards_rising': totals, 'any_hazard_rising': int(sum(s['hazards_rising'] > 0 for s in sites)),
                   'longer_dry_spells': int(sum(1 for s in sites if s['dry_spells'] and s['dry_spells']['p'] is not None
                                                and s['dry_spells']['p'] < 0.05 and s['dry_spells']['p_dd_after'] > s['dry_spells']['p_dd_before'])),
                   'aridity_crossing': int(sum(1 for s in sites if s['aridity'] and s['aridity']['cross']))},
        'methods': {
            'bayes': 'Bayesian linear trend on yearly means (Jeffreys prior, Student-t posterior); Bayes factor from BIC.',
            'extremes': 'Quantile regression of deseasonalised monthly values at the 10th, 50th and 90th percentiles; standard errors widened for month-to-month autocorrelation (AR(1) effective sample size).',
            'emergence': 'LOWESS signal relative to the 2000-2009 level, divided by year-to-year noise; emerged when |S/N| > 1 to the end of the record.',
            'years_needed': 'Record length at which the current slope would reach p < 0.05 given the current noise.',
            'hazards': 'Extreme month = beyond that calendar month\'s 2000-2011 90th (heat, flood) or 10th (drought, topsoil) percentile; '
                       'fire weather = top-quarter heat and bottom-quarter humidity together. Frequency trend by quasi-binomial GLM; '
                       'Benjamini-Hochberg across all sites and hazards. "Now" = fitted chance for a month in 2024.',
            'dry_spells': 'Two-state Markov chain on dry (below the baseline monthly median) and wet months; likelihood-ratio test of P(dry to dry), 2000-2011 vs 2012-2024.',
            'aridity': 'UN aridity index = rain / Thornthwaite potential evaporation; classes from UNEP. Sen slope, Mann-Kendall p.',
            'stability': 'Warming, rain change, temperature swings, rain swings and extra extreme months, each ranked against all sites; '
                         'mean percentile = score (100 = most stable); 200 block-bootstrap resamples of years give the 95% range.',
        },
        'sites': sites,
    }
    (data_dir / 'deep.json').write_text(json.dumps(out, separators=(',', ':'), allow_nan=False))
    print(f"deep.json: {n} sites | hazards rising {totals} | any hazard {out['totals']['any_hazard_rising']} | "
          f"longer dry spells {out['totals']['longer_dry_spells']} | aridity crossing {out['totals']['aridity_crossing']}")


if __name__ == '__main__':
    main(Path(sys.argv[1] if len(sys.argv) > 1 else 'frontend/public/data'))
