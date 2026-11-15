# Active Future Labs — NASA Earth Trends Backend

This is the main backend for our NASA Space Apps Earth System Trend Detective project.

## Files

- `NASA_Earth_Trends_Complete_Backend.ipynb` — run this in Google Colab. It contains the backend and study areas, so no manual CSV upload is necessary.
- `backend.py` — the same Python module, available separately for future deployment.
- `regions.geojson` — geographical rectangles for the 360 study areas.
- `test_backend.py` — offline tests for the collector and API.
- `requirements.txt` — Python dependencies.

## Using the notebook

1. Upload the notebook to Google Colab and run cells in order.
2. Authorise Google Drive access. The database cache is saved to `MyDrive/active_future_labs/nasa_cache.sqlite3`.
3. Run the initial NASA POWER test; sign in to Earthdata when prompted for GLDAS, GPM IMERG and MERRA-2 data.
4. Keep `RUN_FULL_COLLECTION = True` to collect the historical archive in batches. This cell saves after each successful batch and also when a run stops unexpectedly.
5. Check the coverage and model-diagnostic output. Results require sufficient valid observations before a trend is fitted.
6. Use `/docs` and `/api/status` on the local API before giving your frontend teammate the URL.

## Scientific scope and limitations

- All measurements are requested from NASA data services. No observations are invented and no third-party CSV is imported.
- The 360 study areas are **rectangular geographical boxes**, not countries or complete ecological regions.
- Each variable has its own source resolution and coverage. Spatial means use native pixel centres weighted approximately by latitude. NASA POWER may use a flagged nine-point sample approximation where native regional retrieval fails.
- The main comparison period is 2000–2024, with up to 300 monthly observations per area-variable pair.
- Seasonal OLS with HAC errors estimates trends per decade; BH/BY adjusted p-values and diagnostics support interpretation. Not all assumptions are guaranteed.
- The full archive has **not** been downloaded within this package. Run the notebook in an authenticated, internet-connected Colab session and inspect coverage before making conclusions.
- Colab is temporary hosting. A public, continuously available dashboard requires deployment of the backend and its cache.

## Keeping the repository safe

Clear notebook outputs from the Earthdata login cell before publishing. Never commit passwords, tokens or personal credentials. The SQLite cache stores the collected observations but not Earthdata credentials.

## NASA documentation

- [POWER monthly API](https://power.larc.nasa.gov/docs/services/api/temporal/monthly/)
- [earthaccess authentication](https://earthaccess.readthedocs.io/en/stable/user/explanation/authenticate/)
