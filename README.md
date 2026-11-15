# active-future-labs
NASA Space Apps Challenge 2026 | Earth System Trend Detective | Python, Data Science and Environmental Trend Analysis

## Run it on your computer (site + live server)

Terminal 1, the live analysis server (Python):
```bash
pip install -r backend/server/requirements.txt
uvicorn backend.server.app:app --reload --port 8000      # check: http://localhost:8000/api/health
```
Terminal 2, the website:
```bash
cd frontend && npm install && npm run dev                 # http://localhost:5173 (uses the server automatically)
```
Search any town or click anywhere: the server downloads 44 years (1981–2024) of NASA POWER data for that exact spot
(or a 100/250 km area), plus GLDAS, GPM IMERG and MERRA-2 aerosol from the nearest analysed site, and runs every test
(HAC trend, Mann-Kendall, Sen, Bayesian, quantile regression, emergence, disaster outlook). Without the server the site
still works and opens the nearest of the 360 analysed areas.

Tests: `cd frontend && npm test` (31) and `python -m pytest backend/server/test_server.py` (4).

## Go live

1. **Website (GitHub Pages):** repo Settings → Pages → Source: **GitHub Actions**. Every push to `main` publishes it at
   `https://<owner>.github.io/<repo>/`.
2. **Live server (Render, free):** render.com → New → **Blueprint** → choose this repo (it reads `render.yaml`). Copy the
   service URL, e.g. `https://earthwatch-api.onrender.com`.
3. **Connect them:** GitHub repo Settings → Secrets and variables → Actions → **Variables** → New: `API_URL` = that URL.
   Then Actions → "Deploy frontend" → Run workflow. The free server sleeps when idle; the site wakes it on page load.

## Layout

| Folder | What it holds |
|---|---|
| `backend/analysis/` | Colab notebook + `backend.py`: downloads NASA POWER, GLDAS, GPM IMERG and MERRA-2 for 360 study boxes (2000–2024), fits trends, serves an API |
| `backend/export/` | `export_frontend_data.py`: turns the backend's SQLite database into static JSON for the website |
| `frontend/` | The website: CesiumJS globe, lenses, case files ([README](frontend/README.md)) |
| `docs/ARCHITECTURE.md` | How the pieces fit, what came from God's Eye View, how to add a lens |

## Quick start (website)

```bash
cd frontend && npm install && npm run dev
```

The exported data is already in `frontend/public/data/`. Pushing to `main` publishes the site to GitHub Pages (enable Pages → Source: GitHub Actions once).
