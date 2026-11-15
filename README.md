# active-future-labs
NASA Space Apps Challenge 2026 | Earth System Trend Detective | Python, Data Science and Environmental Trend Analysis

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
