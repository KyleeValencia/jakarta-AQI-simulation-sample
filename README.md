# Jakarta AQI — website

A **static, single-page** website for the Jakarta morning-AQI forecast. No backend: a Python
script pre-computes static data files, and a plain HTML/JS/Leaflet page renders them. It is driven
entirely by the **project's own prediction output** (NB8's static-JSON contract), so real forecasts
drop in with no front-end change.

> **Current state: PREVIEW (coming-soon).** The forecasting model is being re-trained on the
> `pm25_conc` target, so per-cell forecast values are **not yet published**. The map and location
> tools are fully live; the AQI readout shows an honest "awaiting model output" state until the
> re-train + NB8 re-run lands. Flip to real numbers with one flag (see *Modes* below).

## What it shows (the three product features)

1. **Choose a location** — *My location* (browser geolocation), *Lat / lon* (type coordinates), or
   click anywhere on the map.
2. **Predicted AQI for that grid cell** — the coordinate is resolved to its H3 **r7** hex cell
   (`h3.latLngToCell`, v4 API — identical to Python `aqi_utils.h3_grid.latlng_to_cell`), and that
   cell's value + ISPU category are shown on the official KLHK colour scale. *(Shows "awaiting
   model output" while in preview mode.)*
3. **Forecast graph** — a weather-style line chart over the locked 3-hour morning steps: **now,
   +3h, +6h**, each point labelled with its ISPU category. *(Appears once forecasts are published.)*

An **About** overlay states the methodology and the honest accuracy limitations.

## Build the data

From the project root, in the `jakarta-aqi` env:

```bash
# Coming-soon / preview (current state — geometry + meta only, no forecast values):
python web/build_web_data.py --mode pending

# After the pm25_conc re-train + NB8 re-run: swap in the real per-cell forecast:
python web/build_web_data.py --mode live
```

`--mode live` reads NB8's canonical `web_data/forecast_r{R}.json` and re-emits it in the front-end
contract — **no front-end change needed**. Resolution defaults to r7 (`--resolution`).

## Run locally

```bash
cd web
python -m http.server 8001        # fetch() needs http, not file://
#   -> open http://localhost:8001
```

(The repo's `.claude/launch.json` has an `aqi-web` config that does exactly this.) Geolocation
works on `localhost` (and on HTTPS in production). Map tiles, Leaflet, Chart.js and h3-js load from
CDNs, so the page needs internet at runtime.

## Deploy

GitHub Pages, serving **this `web/` folder only** (never the project root — it holds the data
mirror and a flagged API key). Step-by-step in **[DEPLOY.md](DEPLOY.md)**.

## Files

| File | Role |
|------|------|
| `build_web_data.py` | Reads `hex_grid_r7.parquet` via `aqi_utils.paths`; writes the three data files. Category/colour come from `aqi_models.physics`. Modes: `pending` / `live`. |
| `data/hexes_r7.geojson` | Hex-cell polygons (+ `h3_id`, center) — the map layer (290 mainland cells). |
| `data/forecast_r7.json` | `{ model_status, anchor_ts, horizons_h, cells: { h3_id: [ {offset_h, value, category, colour} ] } }`. Empty `cells` in preview mode. |
| `data/meta.json` | Resolution, `model_status`, horizons, legend, category order, disclaimers. |
| `index.html`, `app.js`, `style.css` | The static front-end (responsive; reads only `meta.json` + the two data files). |
| `.nojekyll`, `DEPLOY.md` | GitHub Pages config + deploy guide. |

## The data contract (how real predictions plug in)

The front-end only knows `meta.json` + `forecast_r{R}.json`. NB8 (the inference notebook) is the
canonical producer of the per-cell forecast; `build_web_data.py --mode live` re-shapes NB8's output
into the contract above and keeps only cells on the current r7 grid. The `model_status` field
drives the preview-vs-live UI, so no JavaScript changes when forecasts arrive.

## Honest limitations (shown in the About panel)

- **Morning window only** — the pre-dawn anchor + commute hours; Jakarta's afternoon peak is out of
  scope by design.
- **Per-cell accuracy is not independently validatable** — ground truth is only 5 DKI stations, so
  off-station per-cell differences are an *informed display gradient*, not a measured value.
- **Static demonstrator** — serving a *live, on-demand* model is a separate, possibly-paid stage (a
  Python backend host), deliberately deferred. See `docs/PROJECT_STATUS.md` §10.
