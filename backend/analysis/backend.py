"""NASA data and statistics for the Active Future Labs dashboard.

Data always comes from NASA services. The collector does not import another
team member's dataset, create sample measurements, or fill missing values.

The 360 geographical selections are rectangular study areas rather than
countries. Where NASA POWER cannot return a native regional grid, nine real
point requests are used as an explicitly labelled approximation.

This module runs inside Google Colab for collection and testing. The same
backend can later be deployed on a persistent server for the frontend.
"""
from __future__ import annotations

import calendar
import json
import logging
import math
import sqlite3
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
from scipy.stats import t as student_t
from statsmodels.stats.multitest import multipletests
import statsmodels.api as sm
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger(__name__)
POWER_URL = 'https://power.larc.nasa.gov/api/temporal/monthly/regional'
POINT_URL = 'https://power.larc.nasa.gov/api/temporal/monthly/point'
POWER = ('T2M', 'PRECTOTCORR', 'RH2M', 'GWETTOP')
GLDAS = ('soil_moisture', 'evaporation', 'runoff')
IMERG = ('gpm_rain',)
AEROSOL = ('aerosol', 'dust')
VARIABLES = POWER + GLDAS + IMERG + AEROSOL
UNITS = {
    'T2M':'°C', 'PRECTOTCORR':'mm/day', 'RH2M':'%', 'GWETTOP':'fraction',
    'soil_moisture':'kg/m² (0–10 cm)', 'evaporation':'mm/day',
    'runoff':'mm/day', 'gpm_rain':'mm/day',
    'aerosol':'dimensionless AOD', 'dust':'dimensionless AOD'
}
SOURCE = {v:'NASA POWER (MERRA-2 derived)' for v in POWER}
SOURCE.update({v:'NASA GLDAS_NOAH025_M 2.1' for v in GLDAS})
SOURCE.update({v:'NASA GPM_3IMERGM V07' for v in IMERG})
SOURCE.update({v:'NASA M2TMNXAER 5.12.4' for v in AEROSOL})
PRODUCTS = {
    'gldas': dict(short_name='GLDAS_NOAH025_M',version='2.1',
                  fields={'soil_moisture':'SoilMoi0_10cm_inst',
                          'evaporation':'Evap_tavg','runoff':'Qs_acc'}),
    'imerg': dict(short_name='GPM_3IMERGM',version='07', fields={'gpm_rain':'precipitation'}),
    'aerosol':dict(short_name='M2TMNXAER',version='5.12.4',
                   fields={'aerosol':'TOTEXTTAU','dust':'DUEXTTAU'})
}


def date_range(start:int,end:int):
    if start < 1981 or end > 2025 or end < start:
        raise ValueError('This historical demo supports whole years from 1981 through 2025.')
    return pd.date_range(f'{start}-01-01',f'{end}-12-01',freq='MS')


def http_session():
    s=requests.Session()
    retry=Retry(total=3,connect=3,read=2,backoff_factor=1.5,
                status_forcelist=(429,500,502,503,504),respect_retry_after_header=True)
    s.mount('https://',HTTPAdapter(max_retries=retry))
    return s


def _clean(v):
    try: x=float(v)
    except (ValueError,TypeError): return None
    return None if not math.isfinite(x) or x<=-900 else x


def _mean(values,latitudes):
    """Latitude-area weighted means over selected native pixel centres."""
    x=np.asarray(values,dtype=float)
    la=np.broadcast_to(np.asarray(latitudes,dtype=float),x.shape)
    valid=np.isfinite(x)&np.isfinite(la)&(np.abs(la)<=90)
    if not valid.any(): return None,0,int(x.size)
    w=np.cos(np.deg2rad(la[valid]))
    if w.sum()<=0:return None,int(valid.sum()),int(x.size)
    return float(np.average(x[valid],weights=w)),int(valid.sum()),int(x.size)


def _parse_power_geojson(payload,var,start,end,region=None):
    """Extract monthly time series from NASA POWER regional GeoJSON features.

    A non-GeoJSON response is an error, not permission to claim a region mean.
    """
    features=payload.get('features')
    if not isinstance(features,list) or not features:
        raise ValueError('POWER regional response did not include GeoJSON grid features')
    valid_features=[]
    for f in features:
        geom=f.get('geometry') or {}
        coords=geom.get('coordinates') or []
        series=(f.get('properties') or {}).get('parameter',{}).get(var)
        if geom.get('type')!='Point' or len(coords)<2 or not isinstance(series,dict):
            raise ValueError(f'Unexpected POWER regional feature for {var}: {str(f)[:300]}')
        lat, lon = float(coords[1]), float(coords[0])
        # API request boundaries may be padded to satisfy NASA's minimum span.
        # Only cells whose centres fall inside the ORIGINAL box are analysed.
        if region is not None and not (
            float(region['south']) - 1e-9 <= lat <= float(region['north']) + 1e-9 and
            float(region['west']) - 1e-9 <= lon <= float(region['east']) + 1e-9
        ):
            continue
        valid_features.append((lat,series))
    if not valid_features:
        raise ValueError('No native NASA POWER grid-cell centres inside original study box')
    records=[]
    for dt in date_range(start,end):
        key=dt.strftime('%Y%m')
        vals=[_clean(s.get(key)) for _,s in valid_features]
        numeric=np.array([np.nan if v is None else v for v in vals],dtype=float)
        avg,n,total=_mean(numeric,np.array([la for la,_ in valid_features]))
        records.append((dt.strftime('%Y-%m-%d'),avg,n,total))
    return records


def _sample_coords(region):
    """9 interior samples for explicit *approximate* box means.

    These are NOT the full native grid and are never labeled exact area averages.
    """
    lats=np.linspace(float(region['south'])+0.25*(float(region['north'])-float(region['south'])),
                     float(region['north'])-0.25*(float(region['north'])-float(region['south'])),3)
    lons=np.linspace(float(region['west'])+0.25*(float(region['east'])-float(region['west'])),
                     float(region['east'])-0.25*(float(region['east'])-float(region['west'])),3)
    return [(float(la),float(lo)) for la in lats for lo in lons]


def _parse_power_point(payload, start,end):
    vars_dict=(payload.get('properties') or {}).get('parameter',{})
    if not all(isinstance(vars_dict.get(v),dict) for v in POWER):
        raise ValueError('NASA POWER point response is missing required parameters')
    result={}
    for dt in date_range(start,end):
        key=dt.strftime('%Y%m'); ds=dt.strftime('%Y-%m-%d')
        result[ds]={v:_clean(vars_dict[v].get(key)) for v in POWER}
    return result


def retrieve_power(region,start=2000,end=2024,session=None,allow_sample_fallback=True):
    """Return the four POWER time series for one study area.

    Prefer the regional grid response. If its format or geography is rejected,
    collect nine genuine POWER point series and label them as an approximation.
    All four variables use the same method within a study area.
    """
    s=session or http_session()
    # NASA POWER monthly regional requests require a latitude span >= 2 degrees.
    # The original 2-degree boxes can be represented as 1.9999999999999996 in
    # binary floating point. Pad REQUEST extent safely, then filter returned
    # grid-cell centres to the original area in _parse_power_geojson().
    pad = 0.075
    request_bounds = dict(
        south=max(-90, round(float(region['south'])-pad, 5)),
        north=min(90, round(float(region['north'])+pad, 5)),
        west=max(-180, round(float(region['west'])-pad, 5)),
        east=min(180, round(float(region['east'])+pad, 5)),
    )
    if request_bounds['north']-request_bounds['south'] < 2.01:
        raise ValueError(f'NASA POWER native request cannot span >=2.01° latitude near this boundary: {region}')
    output={}
    regional_error=None
    try:
        for var in POWER:
            params={'latitude-min':request_bounds['south'],'latitude-max':request_bounds['north'],
                    'longitude-min':request_bounds['west'],'longitude-max':request_bounds['east'],
                    'parameters':var,'community':'SB','start':start,'end':end,'format':'JSON'}
            response=s.get(POWER_URL,params=params,timeout=(15,120))
            if not response.ok:
                if response.status_code == 422:
                    raise ValueError(f'POWER regional HTTP 422: {response.text[:600]}')
                response.raise_for_status()
            output[var]=_parse_power_geojson(response.json(),var,start,end,region=region)
    except (ValueError, KeyError, TypeError) as exc:
        regional_error=str(exc)
        if not allow_sample_fallback:
            raise RuntimeError(f'POWER native regional retrieval failed: {regional_error}') from exc
    else:
        rows=[]
        for i,(ds,_,_,_) in enumerate(output[POWER[0]]):
            for v in POWER:
                date,x,n,total=output[v][i]
                assert date==ds
                rows.append((region['region_id'],v,date,x,n,total,'native_grid_center_weighted','NASA POWER'))
        return rows,{'method':'native_grid_center_weighted','regional_error':None,
                     'requested_box_was_padded':True,'grid_centres_filtered_to_original_box':True}

    # Clearly labeled, approximate multi-point fallback. No fabricated values.
    sampling=_sample_coords(region)
    sampled=[]
    for la,lo in sampling:
        params={'latitude':la,'longitude':lo,'parameters':','.join(POWER),
                'community':'AG','start':start,'end':end,'format':'JSON'}
        response=s.get(POINT_URL,params=params,timeout=(15,120))
        if not response.ok:
            raise RuntimeError(f'NASA POWER point fallback HTTP {response.status_code}: '
                               f'{response.text[:700]}; original regional error: {regional_error}')
        sampled.append((la,_parse_power_point(response.json(),start,end)))
    rows=[]
    for dt in date_range(start,end):
        ds=dt.strftime('%Y-%m-%d')
        for v in POWER:
            vals=[np.nan if data[ds][v] is None else data[ds][v] for _,data in sampled]
            x,n,total=_mean(vals,[lat for lat,_ in sampled])
            rows.append((region['region_id'],v,ds,x,n,total,'nine_point_area_sample_approximation','NASA POWER'))
    return rows,{'method':'nine_point_area_sample_approximation','regional_error':regional_error,
                 'native_upgrade_attempted':True}


def _standard_lon(lons):
    lo=np.asarray(lons,dtype=float)
    return ((lo+180)%360)-180


def spatial_aggregate(grid, lats,lons,regions):
    a=np.asarray(grid,dtype=float).copy()
    la=np.asarray(lats,dtype=float).reshape(-1)
    lo=_standard_lon(lons).reshape(-1)
    if a.shape!=(len(la),len(lo)):
        raise ValueError(f'Grid dimensions {a.shape}, expected {(len(la),len(lo))}')
    a[~np.isfinite(a)|(a<=-9000)]=np.nan
    out={}
    for reg in regions:
        iy=np.flatnonzero((la>=reg['south'])&(la<=reg['north']))
        ix=np.flatnonzero((lo>=reg['west'])&(lo<=reg['east']))
        if not len(iy) or not len(ix):
            out[reg['region_id']]=(None,0,0)
            continue
        sub=a[np.ix_(iy,ix)]
        latitude_grid=np.broadcast_to(la[iy,None],sub.shape)
        out[reg['region_id']]=_mean(sub,latitude_grid)
    return out


def extract_granule(path,source,regions):
    """Read one downloaded *real NASA* monthly product into regional statistics.

    Returns {variable: {region_id: (value,n_valid,n_pixels)}}.
    Never replaces missing data with zeros or synthetic data.
    """
    if source not in PRODUCTS:raise ValueError(source)
    if source=='imerg':
        import h5py
        with h5py.File(path,'r') as f:
            g=f['Grid']
            lat=np.asarray(g['lat']).reshape(-1)
            lon=np.asarray(g['lon']).reshape(-1)
            raw=np.asarray(g['precipitation'],dtype=float).squeeze()
            if raw.shape==(len(lon),len(lat)):
                raw=raw.T
            if raw.shape!=(len(lat),len(lon)):
                raise ValueError(f'IMERG grid has unexpected shape {raw.shape}')
            raw[raw < 0] = np.nan
            # IMERG's monthly mean precipitation rate is expressed in mm/hour.
            return {'gpm_rain': spatial_aggregate(raw * 24, lat, lon, regions)}
    import xarray as xr
    with xr.open_dataset(path,mask_and_scale=True,decode_cf=True) as ds:
        lat=next((v for v in ('lat','latitude') if v in ds.coords),None)
        lon=next((v for v in ('lon','longitude') if v in ds.coords),None)
        if not lat or not lon:raise ValueError(f'Missing geographic coords: {list(ds.coords)}')
        result={}
        for name,field in PRODUCTS[source]['fields'].items():
            if field not in ds:
                raise ValueError(f'{field} not present in {source} file; available: {list(ds.data_vars)}')
            arr=ds[field]
            for dim in list(arr.dims):
                if dim not in (lat,lon):
                    if arr.sizes[dim]!=1:raise ValueError(f'Unexpected dimension {dim} in {field}')
                    arr=arr.isel({dim:0})
            arr=arr.transpose(lat,lon)
            data=arr.values.astype(float)
            if source=='gldas':
                # Evap_tavg is a mean water flux. One kg/m² corresponds to 1 mm.
                if name=='evaporation':
                    data = data * 86400  # kg/m²/s -> mm/day
                # Qs_acc is the mean accumulated runoff per three-hour interval.
                if name=='runoff':
                    data = data * 8  # kg/m² per 3h -> mm/day
            if name in ('soil_moisture','runoff','aerosol','dust'):
                data[data<0]=np.nan
            result[name]=spatial_aggregate(data,ds[lat].values,ds[lon].values,regions)
    return result


def _granule_month(item):
    raw=item.get('umm',{}).get('TemporalExtent',{}).get('RangeDateTime',{}).get('BeginningDateTime')
    if raw:
        return pd.Timestamp(raw).strftime('%Y%m')
    import re
    label=item.get('umm',{}).get('GranuleUR','')
    m=re.search(r'(?<!\d)((?:19|20)\d{2}(?:0[1-9]|1[0-2]))',label)
    if not m:raise ValueError(f'Unable to determine monthly granule date: {label}')
    return m.group(1)


def detect_granules(source,start,end):
    import earthaccess
    spec=PRODUCTS[source]
    items=earthaccess.search_data(short_name=spec['short_name'],version=spec['version'],
                                  temporal=(f'{start}-01-01',f'{end}-12-31'))
    matches={}
    for item in items:
        key=_granule_month(item)
        if f'{start}01'<=key<=f'{end}12':
            if key in matches:
                raise RuntimeError(f'{source}: multiple NASA granules for {key}; cannot safely choose.')
            matches[key]=item
    return matches


def _now():return datetime.now(timezone.utc).isoformat()


class Service:
    def __init__(self,db_path='nasa_cache.sqlite3'):
        self.db_path=str(db_path)
        Path(self.db_path).parent.mkdir(parents=True,exist_ok=True)
        self.session=http_session()
        self._granule_index={}
        self._init_schema()

    def conn(self):
        c=sqlite3.connect(self.db_path,timeout=30)
        c.row_factory=sqlite3.Row
        c.execute('PRAGMA journal_mode=WAL')
        c.execute('PRAGMA busy_timeout=30000')
        return c

    def _init_schema(self):
        with self.conn() as c:
            c.executescript('''
              CREATE TABLE IF NOT EXISTS regions(
                region_id TEXT PRIMARY KEY, region_label TEXT NOT NULL,
                west REAL NOT NULL,south REAL NOT NULL,east REAL NOT NULL,north REAL NOT NULL,
                kind TEXT NOT NULL DEFAULT 'rectangular_study_box');
              CREATE TABLE IF NOT EXISTS observations(
                region_id TEXT NOT NULL, variable TEXT NOT NULL, date TEXT NOT NULL,
                value REAL, n_valid INTEGER NOT NULL, n_total INTEGER NOT NULL,
                method TEXT NOT NULL, source TEXT NOT NULL, retrieved_at TEXT NOT NULL,
                PRIMARY KEY(region_id,variable,date));
              CREATE INDEX IF NOT EXISTS ix_obs_variable_date ON observations(variable,date);
              CREATE TABLE IF NOT EXISTS sync_log(
                source TEXT NOT NULL, scope TEXT NOT NULL, run_period TEXT NOT NULL,
                state TEXT NOT NULL, notes TEXT, updated_at TEXT NOT NULL,
                PRIMARY KEY(source,scope,run_period));
              CREATE TABLE IF NOT EXISTS trend_results(
                region_id TEXT NOT NULL, variable TEXT NOT NULL,
                start_year INTEGER NOT NULL, end_year INTEGER NOT NULL,
                n_months INTEGER NOT NULL, trend_per_decade REAL,
                ci_low REAL, ci_high REAL, p_raw REAL, p_bh REAL,p_by REAL,
                trend_status TEXT NOT NULL, n_tests INTEGER,
                analyzed_at TEXT NOT NULL,
                PRIMARY KEY(region_id,variable,start_year,end_year));
              CREATE TABLE IF NOT EXISTS trend_diagnostics(
                region_id TEXT NOT NULL, variable TEXT NOT NULL,
                start_year INTEGER NOT NULL,end_year INTEGER NOT NULL,
                diagnostic_json TEXT NOT NULL,
                PRIMARY KEY(region_id,variable,start_year,end_year));
            ''')

    def seed_regions(self, source):
        if isinstance(source,(str,Path)):
            with open(source,encoding='utf-8') as f: obj=json.load(f)
        else:obj=source
        if isinstance(obj,dict) and 'features' in obj:
            items=[]
            for feature in obj['features']:
                p=feature.get('properties',{})
                polygon=feature['geometry']['coordinates'][0]
                items.append(dict(region_id=p['region_id'],region_label=p.get('region_label',p['region_id']),
                    west=min(x[0] for x in polygon),east=max(x[0] for x in polygon),
                    south=min(x[1] for x in polygon),north=max(x[1] for x in polygon)))
        else:
            items=obj
        for r in items:
            if not (-180<=r['west']<r['east']<=180 and -90<=r['south']<r['north']<=90):
                raise ValueError(f'Invalid regional geometry: {r}')
        with self.conn() as c:
            c.executemany('''INSERT INTO regions(region_id,region_label,west,south,east,north)
                VALUES (:region_id,:region_label,:west,:south,:east,:north)
                ON CONFLICT(region_id) DO UPDATE SET region_label=excluded.region_label,
                west=excluded.west,south=excluded.south,east=excluded.east,north=excluded.north''',items)
        return len(items)

    def regions(self):
        with self.conn() as c:return [dict(x) for x in c.execute('SELECT * FROM regions ORDER BY region_id')]

    def region(self,region_id):
        with self.conn() as c:
            x=c.execute('SELECT * FROM regions WHERE region_id=?',(region_id,)).fetchone()
            if x is None:raise KeyError(f'Unknown region: {region_id}')
            return dict(x)

    def _insert(self, rows):
        values=[(*row,_now()) for row in rows]
        with self.conn() as c:
            c.executemany('''INSERT INTO observations
                (region_id,variable,date,value,n_valid,n_total,method,source,retrieved_at)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(region_id,variable,date) DO UPDATE SET
                value=excluded.value,n_valid=excluded.n_valid,n_total=excluded.n_total,
                method=excluded.method,source=excluded.source,retrieved_at=excluded.retrieved_at''', values)
        return len(values)

    def _log(self,source,scope,period,state,notes=''):
        with self.conn() as c:
            c.execute('''INSERT OR REPLACE INTO sync_log
                (source,scope,run_period,state,notes,updated_at) VALUES(?,?,?,?,?,?)''',
                (source,scope,period,state,str(notes)[:2000],_now()))

    def _already(self,source,scope,period):
        with self.conn() as c:
            row=c.execute('SELECT state FROM sync_log WHERE source=? AND scope=? AND run_period=?',
                          (source,scope,period)).fetchone()
        return bool(row and row['state']=='complete')

    def sync_power(self, region_ids=None,start=2000,end=2024,force=False,delay=0.4,
                   max_regions=None,upgrade_approximations=True):
        """Collect each region's four POWER measurements, skipping completed regions.

        A failed regional request can use real NASA point observations, but the
        returned method field always distinguishes it from a native grid mean.
        """
        date_range(start,end)
        all_reg=self.regions()
        ids=set(region_ids) if region_ids is not None else None
        selected=[r for r in all_reg if ids is None or r['region_id'] in ids]
        if ids and len(selected)!=len(ids):raise ValueError('Unknown selected region ID')
        key=f'{start}-{end}'
        pending=[]
        for reg in selected:
            if not force and self._already('POWER',reg['region_id'],key):
                if not upgrade_approximations:
                    continue
                with self.conn() as c:
                    old=c.execute('''SELECT method FROM observations WHERE region_id=?
                        AND variable='T2M' AND date=?''',
                        (reg['region_id'],f'{start}-01-01')).fetchone()
                if old and old['method']=='native_grid_center_weighted':
                    continue
                # A known invalid native request must not be retried on every
                # Colab restart unless force=True; the approximation stays labelled.
                with self.conn() as c:
                    record=c.execute('''SELECT notes FROM sync_log WHERE source='POWER'
                        AND scope=? AND run_period=?''',(reg['region_id'],key)).fetchone()
                if record:
                    try:
                        if json.loads(record['notes']).get('native_upgrade_attempted'):
                            continue
                    except (ValueError,TypeError,AttributeError):
                        pass
            pending.append(reg)
        if max_regions is not None:
            if int(max_regions)<1:raise ValueError('max_regions must be >= 1')
            pending=pending[:int(max_regions)]
        completed=[]
        for index,reg in enumerate(pending,1):
            try:
                records,meta=retrieve_power(reg,start,end,session=self.session)
                self._insert(records)
                self._log('POWER',reg['region_id'],key,'complete',json.dumps(meta))
                completed.append({'region_id':reg['region_id'],**meta})
                log.info('POWER %s of %s: %s (%s)',index,len(pending),reg['region_id'],meta['method'])
                if delay:time.sleep(delay)
            except Exception as exc:
                self._log('POWER',reg['region_id'],key,'error',str(exc))
                raise RuntimeError(f'NASA POWER failed at {reg["region_id"]}: {exc}') from exc
        return completed

    def sync_product(self,source,start=2000,end=2024,max_months=None,force=False):
        """Read native monthly NASA granules once and aggregate ALL 360 regions.

        Uses temporary files for NASA science formats, no manual CSV creation.
        Stores only the regional statistics in SQLite.
        """
        if source not in PRODUCTS:raise ValueError(source)
        if start<2000:raise ValueError('Use 2000 onward for the ten-variable common analysis.')
        date_range(start,end)
        import earthaccess
        # Login occurs in Colab setup cell, not in an HTTP API endpoint.
        regions=self.regions()
        if not regions:raise RuntimeError('Seed regions first')
        months=[dt.strftime('%Y%m') for dt in date_range(start,end)]
        # Missing granules are recorded as a terminal data gap for this run.
        # force=True explicitly rechecks them against updated NASA archives.
        with self.conn() as c:
            terminal={r['run_period'] for r in c.execute('''SELECT run_period FROM sync_log
                  WHERE source=? AND scope='ALL' AND state IN ('complete','missing')''',(source,))}
        outstanding=[m for m in months if force or m not in terminal]
        if max_months is not None:
            outstanding=outstanding[:int(max_months)]
        if not outstanding:return {'source':source,'processed':0,'remaining':0}
        index_key=(source,start,end)
        if index_key not in self._granule_index:
            self._granule_index[index_key]=detect_granules(source,start,end)
        discovered=self._granule_index[index_key]
        if not discovered:
            raise RuntimeError(f'NASA Earthdata CMR returned no {source} granules for {start}-{end}')
        done=[]
        for m in outstanding:
            if m not in discovered:
                self._log(source,'ALL',m,'missing','NASA CMR did not return a monthly granule')
                log.warning('%s %s absent from NASA CMR',source,m)
                continue
            try:
                with tempfile.TemporaryDirectory(prefix='nasa_granule_') as directory:
                    paths=earthaccess.download([discovered[m]],local_path=directory,threads=1,show_progress=False)
                    files=[Path(p) for p in paths if Path(p).is_file() and
                           Path(p).suffix.lower() in ('.nc','.nc4','.h5','.hdf5','.hdf')]
                    if len(files)!=1:
                        raise RuntimeError(f'Expected one downloaded science granule, received {files}')
                    aggregate=extract_granule(files[0],source,regions)
                ds=f'{m[:4]}-{m[4:]}-01'
                rows=[]
                for v,results in aggregate.items():
                    for rid,(value,n_valid,n_total) in results.items():
                        rows.append((rid,v,ds,value,n_valid,n_total,'native_grid_area_weighted',SOURCE[v]))
                self._insert(rows)
                self._log(source,'ALL',m,'complete',f'{len(rows)} values from official NASA product')
                done.append(m)
                log.info('%s %s: %d regional readings stored',source,m,len(rows))
            except Exception as exc:
                self._log(source,'ALL',m,'error',str(exc))
                raise RuntimeError(f'NASA {source} granule failed at {m}: {exc}') from exc
        # Missing source granules count as accounted-for gaps; otherwise the
        # same missing month would cause endless retries on every batch.
        with self.conn() as c:
            resolved={r['run_period'] for r in c.execute('''SELECT run_period FROM sync_log
                WHERE source=? AND scope='ALL' AND state IN ('complete','missing')''',(source,))}
        remaining=len([m for m in months if m not in resolved])
        return {'source':source,'processed':len(done),'months':done,
                'remaining':remaining,'missing_granules':len([m for m in months if m in resolved and m not in discovered])}

    def observations(self,region_id,variable,start=2000,end=2024):
        if variable not in VARIABLES:raise ValueError('Unknown variable')
        self.region(region_id)
        date_range(start,end)
        with self.conn() as c:
            result=c.execute('''SELECT date,value,n_valid,n_total,method,source
                FROM observations WHERE region_id=? AND variable=?
                AND date>=? AND date<=? ORDER BY date''',
                (region_id,variable,f'{start}-01-01',f'{end}-12-31')).fetchall()
        return [dict(r) for r in result]

    def status(self):
        with self.conn() as c:
            n=c.execute('SELECT COUNT(*) FROM regions').fetchone()[0]
            counts=[dict(r) for r in c.execute('''SELECT variable,COUNT(*) AS rows,
                SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) AS valid
                FROM observations GROUP BY variable ORDER BY variable''')]
            jobs=[dict(r) for r in c.execute('''SELECT source,state,COUNT(*) AS count
                FROM sync_log GROUP BY source,state ORDER BY source,state''')]
        return {'region_count':n,'variables':counts,'sync_jobs':jobs,
                'source_progress':self.source_progress(),
                'fully_populated':False if not counts else all(
                  next((r['valid'] for r in counts if r['variable']==v),0)>=n*300 for v in VARIABLES)}

    def source_progress(self,start=2000,end=2024):
        months=12*(end-start+1)
        reg_count=len(self.regions())
        with self.conn() as c:
            power=c.execute("""SELECT COUNT(*) FROM sync_log
                WHERE source='POWER' AND state='complete' AND run_period=?""",
                (f'{start}-{end}',)).fetchone()[0]
            product={}
            for source in PRODUCTS:
                completed=c.execute("""SELECT COUNT(*) FROM sync_log
                    WHERE source=? AND scope='ALL' AND state='complete'
                    AND run_period BETWEEN ? AND ?""",
                    (source,f'{start}01',f'{end}12')).fetchone()[0]
                absent=c.execute("""SELECT COUNT(*) FROM sync_log
                    WHERE source=? AND scope='ALL' AND state='missing'
                    AND run_period BETWEEN ? AND ?""",
                    (source,f'{start}01',f'{end}12')).fetchone()[0]
                product[source]={'complete_months':completed,'missing_months':absent,'expected_months':months}
        all_requested=power==reg_count and all(d['complete_months']+d['missing_months']==months
                                               for d in product.values())
        return {'power_complete_regions':power,'expected_regions':reg_count,
                'earthdata':product,'all_requests_accounted_for':all_requested}

    def data_quality(self,start=2000,end=2024):
        """Summarise coverage and flag suspicious measurements for human review.

        The range limits are screening thresholds, not automatic data filters.
        A range warning does not prove the NASA observation is invalid.
        """
        validation_ranges={
            'T2M':(-100,70),'PRECTOTCORR':(0,250),'RH2M':(0,100),
            'GWETTOP':(0,1),'soil_moisture':(0,120),'evaporation':(-30,80),
            'runoff':(0,200),'gpm_rain':(0,250),'aerosol':(0,20),'dust':(0,20)
        }
        expected=12*(end-start+1)
        with self.conn() as c:
            rows=c.execute("""SELECT variable, COUNT(*) AS stored_months,
                SUM(CASE WHEN value IS NOT NULL THEN 1 ELSE 0 END) AS valid_months,
                SUM(CASE WHEN value IS NOT NULL AND (n_total<=0 OR n_valid<=0 OR n_valid>n_total)
                    THEN 1 ELSE 0 END) AS pixel_count_errors,
                SUM(CASE WHEN value IS NOT NULL AND n_total>0 AND n_valid*1.0/n_total<0.5
                    THEN 1 ELSE 0 END) AS low_pixel_coverage,
                MIN(value) AS min_value,MAX(value) AS max_value
                FROM observations WHERE date>=? AND date<=?
                GROUP BY variable ORDER BY variable""",
                (f'{start}-01-01',f'{end}-12-31')).fetchall()
        report=[]
        for row in rows:
            d=dict(row)
            lo,hi=validation_ranges[d['variable']]
            d['expected_rows']=len(self.regions())*expected
            d['coverage_fraction']=float(d['valid_months'] or 0)/d['expected_rows']
            d['range_warning']=bool(d['min_value'] is not None and (d['min_value']<lo or d['max_value']>hi))
            d['suggested_sanity_range']=[lo,hi]
            report.append(d)
        return report

    def fit_trend(self,region_id,variable,start=2000,end=2024,min_months=60,min_coverage=.8):
        from statsmodels.stats.diagnostic import acorr_ljungbox
        from scipy.stats import theilslopes
        rows=self.observations(region_id,variable,start,end)
        expected=12*(end-start+1)
        valid=[r for r in rows if r['value'] is not None and r['n_valid']>=1 and r['n_total']>=r['n_valid']>=1
               and r['n_valid']/r['n_total']>=0.5]
        preliminary={'region_id':region_id,'variable':variable,'period':[start,end],
                     'available_months':len(valid),'expected_months':expected,
                     'pixel_coverage_threshold':0.5}
        if len(valid)<max(min_months,math.ceil(expected*min_coverage)):
            return {**preliminary,'status':'insufficient_data',
                    'message':'Not enough valid NASA monthly observations. No missing months are imputed.'}
        work=pd.DataFrame(valid)
        dates=pd.to_datetime(work['date']); months=dates.dt.month
        t=(dates.dt.year-start)+(months-1)/12
        y=work['value'].astype(float).to_numpy()
        if np.nanstd(y)<1e-10:
            return {**preliminary,'status':'constant_series',
                    'message':'No sufficient variation for a meaningful trend significance test.'}
        X=pd.get_dummies(months,prefix='month',drop_first=True,dtype=float)
        X.insert(0,'time_years',t.to_numpy(dtype=float))
        X=sm.add_constant(X,has_constant='add')
        model=sm.OLS(y,X).fit(cov_type='HAC',cov_kwds={'maxlags':12})
        alternative=sm.OLS(y,X).fit(cov_type='HAC',cov_kwds={'maxlags':24})
        slope=float(model.params['time_years'])*10
        ci=(model.conf_int().loc['time_years'].to_numpy(dtype=float)*10).tolist()
        p=float(model.pvalues['time_years'])
        if not all(math.isfinite(z) for z in [slope,*ci,p]):
            return {**preliminary,'status':'invalid_inference',
                    'message':'Regression returned non-finite estimates; p-values omitted.'}
        ci24=(alternative.conf_int().loc['time_years'].to_numpy(dtype=float)*10).tolist()
        p24=float(alternative.pvalues['time_years'])
        residual=np.asarray(model.resid,dtype=float)
        acf1=float(pd.Series(residual).autocorr(lag=1)) if len(residual)>2 else None
        lb_p=float(acorr_ljungbox(residual,lags=[12],return_df=True)['lb_pvalue'].iloc[0])
        # Theil-Sen on annual mean monthly anomalies (descriptive sensitivity only).
        temp=work.assign(year=dates.dt.year.to_numpy(),month=months.to_numpy())
        climatology=temp.groupby('month')['value'].transform('mean')
        temp['anomaly']=temp['value']-climatology
        yr=temp.groupby('year').agg(anomaly=('anomaly','mean'),count=('anomaly','size'))
        yr=yr[yr['count']>=9]
        sen=None
        if len(yr)>=15:
            slope_annual,intercept,lo,hi=theilslopes(yr['anomaly'].to_numpy(),yr.index.to_numpy(),0.95)
            sen={'annual_theil_sen_per_decade':float(slope_annual)*10,
                 'ci95_descriptive':[float(lo)*10,float(hi)*10],
                 'years_used':len(yr),
                 'warning':'Descriptive only; conventional Theil-Sen bounds may not account for serial correlation.'}
        methods=sorted(set(r['method'] for r in valid))
        return {**preliminary,'status':'preliminary_trend',
                'trend_per_decade':slope,'unit':UNITS[variable]+'/decade',
                'ci95':[float(ci[0]),float(ci[1])],'p_raw':p,
                'method':'Seasonal OLS + Newey-West HAC(12)',
                'multiple_testing':'Unadjusted single test; run recompute_trends for FDR.',
                'retrieval_methods':methods,
                'spatial_warning':('Nine-point samples are an approximation, not a true area mean.'
                    if any(x=='nine_point_area_sample_approximation' for x in methods)
                    else 'Native pixel-centre weighted values inside rectangular study box, not official region boundaries.'),
                'diagnostics':{
                    'residual_ljung_box_12_p':lb_p,
                    'residual_autocorrelation_lag1':acf1,
                    'residual_autocorrelation_flag':bool(math.isfinite(lb_p) and lb_p<.05),
                    'hac24_p':p24,'hac24_ci95':[float(x) for x in ci24],
                    'significance_sensitivity_hac12_vs_24':bool((p<.05)!=(p24<.05)),
                    'annual_theil_sen':sen,
                    'notes':'Diagnostics are model checks, not proof of validity. Strong residual dependence warrants additional review.'
                }}

    def recompute_trends(self,start=2000,end=2024):
        results=[]
        for reg in self.regions():
            for var in VARIABLES:
                item=self.fit_trend(reg['region_id'],var,start,end)
                if item['status']=='preliminary_trend':results.append(item)
        if not results:return {'fitted':0,'message':'No region-variable series meets coverage requirements.'}
        progress=self.source_progress(start,end)
        fdr_complete=progress['all_requests_accounted_for']
        pvals=[r['p_raw'] for r in results]
        pbh=multipletests(pvals,method='fdr_bh')[1]
        pby=multipletests(pvals,method='fdr_by')[1]
        with self.conn() as c:
            c.execute('DELETE FROM trend_results WHERE start_year=? AND end_year=?',(start,end))
            c.execute('DELETE FROM trend_diagnostics WHERE start_year=? AND end_year=?',(start,end))
            c.executemany('''INSERT INTO trend_results
                (region_id,variable,start_year,end_year,n_months,trend_per_decade,ci_low,ci_high,
                p_raw,p_bh,p_by,trend_status,n_tests,analyzed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                [(r['region_id'],r['variable'],start,end,r['available_months'],r['trend_per_decade'],
                  r['ci95'][0],r['ci95'][1],r['p_raw'],float(pbh[i]),float(pby[i]),
                  'completed_collection_trend' if fdr_complete else 'preliminary_trend',
                  len(results),_now()) for i,r in enumerate(results)])
            c.executemany('''INSERT INTO trend_diagnostics
                (region_id,variable,start_year,end_year,diagnostic_json) VALUES (?,?,?,?,?)''',
                [(r['region_id'],r['variable'],start,end,json.dumps(r['diagnostics'])) for r in results])
        return {'fitted':len(results),'bh_significant_05':int((pbh<.05).sum()),
                'by_significant_05':int((pby<.05).sum()),
                'multiple_testing_final_for_synced_collection':fdr_complete,
                'warning':('Data collection is incomplete; FDR results will change as more tests become eligible.'
                           if not fdr_complete else 'Collection jobs accounted for; model assumptions and provenance still require review.'),
                'source_progress':progress}

    def cached_trend(self,region_id,variable,start,end):
        with self.conn() as c:
            item=c.execute('''SELECT * FROM trend_results WHERE region_id=? AND variable=?
                AND start_year=? AND end_year=?''',(region_id,variable,start,end)).fetchone()
        if item is None:return None
        result=dict(item)
        with self.conn() as c:
            diag=c.execute('''SELECT diagnostic_json FROM trend_diagnostics
                WHERE region_id=? AND variable=? AND start_year=? AND end_year=?''',
                (region_id,variable,start,end)).fetchone()
        if diag:result['diagnostics']=json.loads(diag['diagnostic_json'])
        return result

    def backup(self,dest):
        dest=Path(dest);dest.parent.mkdir(parents=True,exist_ok=True)
        with self.conn() as src:
            with sqlite3.connect(dest) as target:src.backup(target)
        return str(dest)


def make_app(service:Service):
    """Read-only HTTP interface; expensive sync operations happen in notebook cells."""
    from fastapi import FastAPI,HTTPException,Query
    from fastapi.middleware.cors import CORSMiddleware
    api=FastAPI(title='Active Future Labs — NASA Earth Trends',version='1.0.0',
                description='NASA-only observations. Regional boxes are not official administrative regions.')
    # Public read-only scientific information. No privileged mutation endpoint.
    api.add_middleware(CORSMiddleware,allow_origins=['*'],allow_methods=['GET'],allow_headers=['*'])

    @api.get('/health')
    def health():return {'status':'running','data_origin':'NASA APIs only','cache':'SQLite'}

    @api.get('/api/regions')
    def regions():return {'regions':service.regions(),'type':'rectangular_study_areas'}

    @api.get('/api/variables')
    def variables():return {'variables':[{'id':v,'unit':UNITS[v], 'nasa_source':SOURCE[v]} for v in VARIABLES]}

    @api.get('/api/status')
    def status():return service.status()

    @api.get('/api/quality')
    def quality(start:int=2000,end:int=2024):
        return {'period':[start,end],'report':service.data_quality(start,end)}

    @api.get('/api/geojson')
    def geojson():
        features=[]
        for r in service.regions():
            w,s,e,n=(r['west'],r['south'],r['east'],r['north'])
            features.append({'type':'Feature','properties':{'region_id':r['region_id'],
                                'region_label':r['region_label'],'semantics':r['kind']},
                             'geometry':{'type':'Polygon','coordinates':[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}})
        return {'type':'FeatureCollection','features':features}

    @api.get('/api/coverage')
    def coverage(region:str,start:int=2000,end:int=2024):
        try:service.region(region);date_range(start,end)
        except (ValueError,KeyError) as exc:raise HTTPException(400,str(exc)) from exc
        expected=12*(end-start+1)
        return {'region':region,'period':[start,end],'variables':[
            {'id':v,'available_months':len(service.observations(region,v,start,end)),
             'valid_months':sum(r['value'] is not None for r in service.observations(region,v,start,end)),
             'expected_months':expected} for v in VARIABLES]}

    @api.get('/api/trends')
    def trends(variable:str,start:int=2000,end:int=2024):
        if variable not in VARIABLES:raise HTTPException(400,'Unknown variable')
        with service.conn() as c:
            rows=[dict(r) for r in c.execute('''SELECT * FROM trend_results WHERE variable=?
                 AND start_year=? AND end_year=? ORDER BY region_id''',(variable,start,end))]
        return {'variable':variable,'period':[start,end],'count':len(rows),
                'message':'Batch FDR-corrected trends; check status and source_progress for provisional results.',
                'source_progress':service.source_progress(start,end),
                'results':rows}

    @api.get('/api/relationships')
    def relationships(region:str,x:str='PRECTOTCORR',y:str='soil_moisture',
                      lag:int=0,start:int=2000,end:int=2024):
        if not (x in VARIABLES and y in VARIABLES):
            raise HTTPException(400,'Unknown environmental variable')
        if not 0<=lag<=12:raise HTTPException(400,'Lag must be 0..12 months')
        try:
            a=service.observations(region,x,start,end)
            b=service.observations(region,y,start,end)
        except (ValueError,KeyError) as exc:raise HTTPException(400,str(exc)) from exc
        left=pd.DataFrame(a)
        right=pd.DataFrame(b)
        if left.empty or right.empty:
            return {'status':'insufficient_data','region':region,'x':x,'y':y,'lag_months':lag}
        joined=left[['date','value']].rename(columns={'value':'x'}).merge(
            right[['date','value']].rename(columns={'value':'y'}),on='date',how='inner')
        joined['date']=pd.to_datetime(joined.date)
        joined=joined.sort_values('date').set_index('date')
        # Reindex ensures lag is in real calendar months, not observed row positions.
        joined=joined.reindex(date_range(start,end))
        for variable in ('x','y'):
            joined[variable+'_anomaly']=joined[variable]-joined.groupby(joined.index.month)[variable].transform('mean')
        joined['x_lagged']=joined['x_anomaly'].shift(lag)
        paired=joined[['x_lagged','y_anomaly']].dropna()
        if len(paired)<60 or paired.x_lagged.std()==0 or paired.y_anomaly.std()==0:
            return {'status':'insufficient_data','region':region,'x':x,'y':y,'lag_months':lag,
                    'paired_months':len(paired)}
        return {'status':'descriptive_association','region':region,'x':x,'y':y,
                'lag_months':lag,'paired_months':len(paired),
                'pearson_r':float(paired.x_lagged.corr(paired.y_anomaly)),
                'method':'calendar-month anomalies; x leads y by lag months',
                'warning':'Exploratory correlation only; no causal or autocorrelation-adjusted significance claim.'}

    @api.get('/api/observations')
    def observations(region:str,variable:str,start:int=2000,end:int=2024):
        try:
            rows=service.observations(region,variable,start,end)
            return {'region':region,'variable':variable,'period':[start,end], 'expected_months':12*(end-start+1),
                    'available_months':len(rows),'valid_months':sum(x['value'] is not None for x in rows),
                    'unit':UNITS[variable],'observations':rows}
        except (KeyError,ValueError) as exc:raise HTTPException(400,str(exc)) from exc

    @api.get('/api/trend')
    def trend(region:str,variable:str,start:int=2000,end:int=2024):
        try:
            result=service.fit_trend(region,variable,start,end)
            if result['status']=='preliminary_trend':
                cached=service.cached_trend(region,variable,start,end)
                if cached:
                    result['p_bh']=cached['p_bh']
                    result['p_by']=cached['p_by']
                    result['multiple_testing']=('Precomputed FDR across '+str(cached['n_tests'])+
                        ' fitted tests; '+cached['trend_status'])
            return result
        except (KeyError,ValueError) as exc:raise HTTPException(400,str(exc)) from exc

    @api.get('/api/compare')
    def compare(variable:str,regions:str,start:int=2000,end:int=2024):
        ids=[r.strip() for r in regions.split(',') if r.strip()]
        if len(ids)>12:raise HTTPException(400,'Compare at most 12 region IDs per request')
        try:
            results=[]
            for r in ids:
                item=service.fit_trend(r,variable,start,end)
                cached=service.cached_trend(r,variable,start,end)
                if cached and item['status']=='preliminary_trend':
                    item['p_bh']=cached['p_bh'];item['p_by']=cached['p_by']
                results.append(item)
            return {'variable':variable,'results':results}
        except (KeyError,ValueError) as exc:raise HTTPException(400,str(exc)) from exc
    return api
