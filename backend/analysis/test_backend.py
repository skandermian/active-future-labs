import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock

import numpy as np
import pandas as pd

import backend as m

REG = dict(region_id='NASA_REGION_0001',region_label='Amazon test',west=-61.02,east=-59.02,south=-4.1,north=-2.1)


def test_geojson_parse():
    values={'200001':24.0,'200002':26.0}
    p={'features':[{'geometry':{'type':'Point','coordinates':[-60,-3]},'properties':{'parameter':{'T2M':values}}},
                   {'geometry':{'type':'Point','coordinates':[-59.5,-3.5]},'properties':{'parameter':{'T2M':{'200001':26.0,'200002':28.0}}}}]}
    rows=m._parse_power_geojson(p,'T2M',2000,2000)
    assert len(rows)==12
    assert 24<rows[0][1]<26
    assert rows[0][2:]==(2,2)
    assert rows[-1][1] is None


def test_point_fallback_and_label():
    class R:
        def __init__(self,url,params):
            self.ok = '/point' in url
            self.status_code=200 if self.ok else 422
            self.text='NASA rejected regional bounding box'
            self.params=params
        def json(self):
            return {'properties':{'parameter':{v:{f'{yy}{mm:02d}':20.0+i for yy in [2000] for mm in range(1,13)}
                                               for i,v in enumerate(m.POWER)}}}
    class S:
        def __init__(self):self.calls=[]
        def get(self,url,params,timeout):
            self.calls.append((url,params))
            return R(url,params)
    s=S()
    rows,metadata=m.retrieve_power(REG,2000,2000,session=s)
    assert len(rows)==4*12
    assert len(s.calls)==10  # one rejected regional + nine point calls
    assert all(r[-2]=='nine_point_area_sample_approximation' for r in rows)
    assert abs(rows[0][3]-20.0)<1e-10
    assert metadata['regional_error']


def test_sqlite_and_stats():
    with TemporaryDirectory() as d:
        service=m.Service(Path(d)/'data.sqlite3')
        service.seed_regions([REG])
        assert len(service.regions())==1
        rows=[]
        for i,dt in enumerate(m.date_range(2000,2024)):
            y=12+0.07*i/12+np.sin(i/12*2*np.pi)
            rows.append((REG['region_id'],'T2M',dt.strftime('%Y-%m-%d'),y,5,5,'native_grid_area_weighted','NASA POWER'))
        service._insert(rows)
        result=service.fit_trend(REG['region_id'],'T2M',2000,2024)
        assert result['status']=='preliminary_trend'
        assert abs(result['trend_per_decade']-0.7)<0.001
        assert result['ci95'][0]<=result['trend_per_decade']<=result['ci95'][1]
        all_=service.recompute_trends()
        assert all_['fitted']==1
        cached=service.cached_trend(REG['region_id'],'T2M',2000,2024)
        assert cached['p_bh'] is not None
        dest=service.backup(Path(d)/'backup.sqlite3')
        assert Path(dest).exists()


def test_spatial_aggregation_and_missing():
    regs=[REG,dict(region_id='elsewhere',west=0,east=2,south=0,north=2)]
    arr=np.array([[1.0,3.0],[2.0,-9999.]])
    out=m.spatial_aggregate(arr,np.array([-3.5,-2.5]),np.array([-60.5,-59.5]),regs)
    assert 1<out[REG['region_id']][0]<3
    assert out[REG['region_id']][1]==3
    assert out['elsewhere']==(None,0,0)


def test_gldas_units_from_netcdf():
    import xarray as xr
    with TemporaryDirectory() as d:
        ds=xr.Dataset({
            'SoilMoi0_10cm_inst':(('time','lat','lon'),np.full((1,2,2),20.)),
            'Evap_tavg':(('time','lat','lon'),np.full((1,2,2),1/86400)),
            'Qs_acc':(('time','lat','lon'),np.full((1,2,2),2.))
        },coords={'time':[pd.Timestamp('2000-01-01')], 'lat':[-3.5,-2.5], 'lon':[-60.5,-59.5]})
        fn=Path(d)/'test.nc'
        ds.to_netcdf(fn)
        got=m.extract_granule(fn,'gldas',[REG])
        assert abs(got['soil_moisture'][REG['region_id']][0]-20)<1e-10
        assert abs(got['evaporation'][REG['region_id']][0]-1)<1e-8
        assert abs(got['runoff'][REG['region_id']][0]-16)<1e-10


def test_api():
    from fastapi.testclient import TestClient
    with TemporaryDirectory() as d:
        service=m.Service(Path(d)/'test.sqlite')
        service.seed_regions([REG])
        app=m.make_app(service)
        client=TestClient(app)
        assert client.get('/health').status_code==200
        assert len(client.get('/api/variables').json()['variables'])==10
        assert len(client.get('/api/regions').json()['regions'])==1
        assert client.get('/api/trend',params={'region':REG['region_id'],'variable':'T2M'}).json()['status']=='insufficient_data'
        assert client.get('/api/observations',params={'region':'BAD','variable':'T2M'}).status_code==400


def test_power_padding_preserves_original_geometry():
    class FakeResponse:
        ok=True
        status_code=200
        def __init__(self,params):self.params=params
        def json(self):
            variable=self.params['parameters']
            period={f'2000{m:02d}':20.0 for m in range(1,13)}
            extra={f'2000{m:02d}':500.0 for m in range(1,13)}
            return {'features':[
                {'geometry':{'type':'Point','coordinates':[-60,-3]},
                 'properties':{'parameter':{variable:period}}},
                # deliberately outside original box but INSIDE the padded request
                {'geometry':{'type':'Point','coordinates':[-61.06,-3]},
                 'properties':{'parameter':{variable:extra}}}
            ]}
    class FakeSession:
        def __init__(self):self.calls=[]
        def get(self,url,params,timeout):
            self.calls.append((url,params))
            return FakeResponse(params)
    client=FakeSession()
    records,info=m.retrieve_power(REG,2000,2000,session=client)
    assert info['method']=='native_grid_center_weighted'
    assert len(client.calls)==4
    assert all(p['latitude-max']-p['latitude-min']>2 for _,p in client.calls)
    assert all(row[3]==20 and row[4]==1 and row[5]==1 for row in records)


def test_api_diagnostics_and_data_quality():
    from fastapi.testclient import TestClient
    with TemporaryDirectory() as tmp:
        service=m.Service(Path(tmp)/'main.sqlite')
        service.seed_regions([REG])
        rows=[]
        rng=np.random.default_rng(123)
        for i,dt in enumerate(m.date_range(2000,2024)):
            rows.append((REG['region_id'],'T2M',dt.strftime('%Y-%m-%d'),
                         25.0+0.15*i/12+2*np.sin(i*np.pi/6)+float(rng.normal(0,0.7)),
                         4,4,'native_grid_center_weighted','NASA POWER'))
        service._insert(rows)
        r=service.fit_trend(REG['region_id'],'T2M')
        assert r['status']=='preliminary_trend'
        assert r['diagnostics']['annual_theil_sen']['years_used']==25
        assert 0<=r['diagnostics']['residual_ljung_box_12_p']<=1
        assert 0<=r['diagnostics']['hac24_p']<=1
        assert service.source_progress()['all_requests_accounted_for'] is False
        a=service.recompute_trends()
        assert a['fitted']==1 and not a['multiple_testing_final_for_synced_collection']
        assert service.cached_trend(REG['region_id'],'T2M',2000,2024)['diagnostics']['hac24_ci95']
        client=TestClient(m.make_app(service))
        assert len(client.get('/api/quality').json()['report'])==1
        assert client.get('/api/trend',params={'region':REG['region_id'],'variable':'T2M'}).json()['diagnostics']


def test_constant_temperature_avoids_invalid_pvalues():
    with TemporaryDirectory() as tmp:
        service=m.Service(Path(tmp)/'data.sqlite')
        service.seed_regions([REG])
        service._insert([(REG['region_id'],'GWETTOP',d.strftime('%Y-%m-%d'),0,2,2,
                          'native_grid_center_weighted','NASA POWER')
                         for d in m.date_range(2000,2024)])
        result=service.fit_trend(REG['region_id'],'GWETTOP')
        assert result['status']=='constant_series'
