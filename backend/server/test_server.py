"""Offline tests for the live server: NASA POWER is replaced by a fake answer."""
import numpy as np
from fastapi.testclient import TestClient
import backend.server.app as srv


def fake_power(lat, lon, params=None):
    rng = np.random.default_rng(int(abs(lat * 100 + lon)))
    n = (srv.LIVE_END - srv.LIVE_START + 1) * 12
    t = np.arange(n)
    season = np.sin(t / 12 * 2 * np.pi)
    return {'T2M': 10 + 8 * season + 0.003 * t + rng.normal(0, 0.8, n),
            'PRECTOTCORR': np.clip(2 + season + rng.normal(0, 0.6, n), 0, None),
            'RH2M': 70 + 5 * season + rng.normal(0, 3, n),
            'GWETTOP': np.clip(0.5 + 0.1 * season + rng.normal(0, 0.05, n), 0.02, 1),
            'T2M_MAX': 15 + 8 * season + 0.004 * t + rng.normal(0, 1, n), 'T2M_MIN': 5 + 8 * season + rng.normal(0, 1, n),
            'QV2M': 7 + 2 * season + rng.normal(0, 0.3, n), 'GWETROOT': np.clip(0.55 + rng.normal(0, 0.04, n), 0, 1),
            'ALLSKY_SFC_SW_DWN': 4 + 2 * season + rng.normal(0, 0.2, n), 'WS50M': 6 + rng.normal(0, 0.5, n)}


srv._real_fetch_power = srv.fetch_power
srv.fetch_power = fake_power
client = TestClient(srv.app)


def test_health():
    r = client.get('/api/health')
    assert r.status_code == 200 and r.json()['sites'] == 360


def test_place_has_every_variable_and_the_outlook():
    r = client.get('/api/place', params={'lat': 53.48, 'lon': -2.24, 'label': 'Manchester'})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d['place']['label'] == 'Manchester' and d['nearest_site']['name'] == 'London'
    assert {'T2M', 'PRECTOTCORR', 'RH2M', 'GWETTOP', 'soil_moisture', 'evaporation', 'runoff', 'gpm_rain', 'aerosol', 'dust'} <= set(d['variables'])
    t = d['variables']['T2M']
    assert t['trend']['first_year'] == 1981 and t['trend']['last_year'] == 2024
    assert t['trend']['verdict'] == 'significant' and t['mk']['p'] < 0.05      # the fake series warms 0.36 °C/decade
    assert set(d['outlook']['hazards']) == {'heat', 'drought', 'flood', 'fire'}


def test_bad_coordinates_are_rejected():
    assert client.get('/api/place', params={'lat': 95, 'lon': 0}).status_code == 422


def test_sixteen_variables_and_area_mode():
    d = client.get('/api/place', params={'lat': 53.48, 'lon': -2.24, 'radius_km': 100}).json()
    assert len(d['variables']) == 16 and d['area']['points'] == 9
    for v in d['variables']:
        assert v in d['meta'] and d['meta'][v]['label']
    assert d['variables']['T2M_MAX']['trend']['verdict'] == 'significant'


def _gappy_request(frac, dry=False):
    """Stands in for NASA POWER in places with patchy records: random empty months, optionally almost no rain."""
    rng = np.random.default_rng(1)
    n = (srv.LIVE_END - srv.LIVE_START + 1) * 12
    m = np.arange(n) % 12
    T = 29 + 3 * np.sin(2 * np.pi * m / 12) + rng.normal(0, .5, n) + np.arange(n) * 0.003
    d = {'T2M': T, 'PRECTOTCORR': np.where(rng.random(n) < (.85 if dry else 0), 0, rng.gamma(.5, 2, n)),
         'RH2M': 35 + rng.normal(0, 5, n), 'GWETTOP': .2 + rng.normal(0, .03, n), 'T2M_MAX': T + 8, 'T2M_MIN': T - 8,
         'QV2M': 8 + rng.normal(0, 1, n), 'GWETROOT': .2 + rng.normal(0, .02, n), 'ALLSKY_SFC_SW_DWN': 6 + rng.normal(0, .3, n),
         'WS50M': 4 + rng.normal(0, .3, n)}
    for v in d:
        d[v][rng.random(n) < frac] = np.nan
    return lambda lat, lon, params: {k: d[k].copy() for k in params}


def test_patchy_nasa_records_still_give_a_full_report(monkeypatch):
    """Regression: missing months (common in parts of Africa / South Asia) used to crash the outlook with HTTP 500."""
    monkeypatch.setattr(srv, 'fetch_power', srv.__dict__['_real_fetch_power'])
    for frac, dry in [(.1, False), (.25, True), (.4, False)]:
        monkeypatch.setattr(srv, '_power_request', _gappy_request(frac, dry))
        r = client.get('/api/place', params={'lat': 13.5, 'lon': 2.1})       # Niamey, Niger
        assert r.status_code == 200, r.text
        j = r.json()
        assert len(j['outlook']['hazards']) == 4
        assert all(x['trend'] for k, x in j['variables'].items() if k in srv.POWER)


def test_fill_gaps_only_fills_short_gaps():
    x = np.arange(24, dtype=float)
    x[[3, 4]] = np.nan                       # year 1: two months missing -> filled
    x[18:24] = np.nan                        # year 2: six months missing -> left empty
    y = srv.fill_gaps(x)
    assert np.isfinite(y[:12]).all() and np.isnan(y[18:24]).all()
