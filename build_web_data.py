"""
build_web_data.py
=================

Build the static data files the Jakarta-AQI website consumes:

  web/data/hexes_r{R}.geojson   hex-cell polygons (+ h3_id, center) for the map
  web/data/forecast_r{R}.json   per-cell forecast in the frontend contract
  web/data/meta.json            resolution, horizons, legend, status, disclaimers

The site is STATIC (no backend): this script pre-computes everything the
front-end fetch()es. It is the single producer of the ``web/data`` contract, so
the front-end never has to know how the pipeline produces forecasts.

Two modes (``--mode``):

  pending (default)  Coming-soon. Geometry + meta are real; the forecast is
                     EMPTY and ``model_status="pending_retrain"``. The site shows
                     the full UI but an honest "awaiting model output" state.
                     Use this until the pm25_conc re-train + NB8 re-run lands.

  live               Reads NB8's real per-cell forecast (the canonical NB8 output
                     ``web_data/forecast_r{R}.json``) and re-emits it in the
                     frontend contract. This is the one-flag swap after re-train.

Resolution defaults to r7 (the modelled / thesis resolution).

Portable: sets AQI_INPUT_ROOT / AQI_WORKING_ROOT to the local mirror and routes
all reads through aqi_utils.paths, so it runs unchanged on Kaggle (env vars
unset -> /kaggle fallback).

Reuses (does NOT reinvent):
  * aqi_models.physics  -> ISPU index -> category + official KLHK colour
  * aqi_utils.paths     -> WORKING_ROOT, upstream_dir(), hex_grid_name()
  * aqi_utils.constants -> category order
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

# -----------------------------------------------------------------------------
# Portable bootstrap: point aqi_utils at the LOCAL mirror, then import it.
# (On Kaggle these env vars are unset and paths.py falls back to /kaggle.)
# -----------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("AQI_INPUT_ROOT", str(PROJECT_ROOT / "kaggle" / "input"))
os.environ.setdefault("AQI_WORKING_ROOT", str(PROJECT_ROOT / "kaggle" / "working"))
sys.path.insert(0, str(PROJECT_ROOT / "jakarta-aqi-utils-fix"))

import geopandas as gpd  # noqa: E402

from aqi_utils import constants, paths  # noqa: E402
from aqi_models.physics import (  # noqa: E402
    ISPU_CATEGORY_COLOR,
    ISPU_INDEX_CATEGORY,
)

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------
OUT_DIR = PROJECT_ROOT / "web" / "data"
COORD_NDIGITS = 5  # ~1 m; trims the GeoJSON payload without visible loss

# Horizons the model forecasts: anchor, +3h, +6h (the locked 3-step morning window).
HORIZONS_H = [0, 3, 6]

# English glosses for the Indonesian category labels (display only).
CATEGORY_ENGLISH = {
    "BAIK": "Good",
    "SEDANG": "Moderate",
    "TIDAK SEHAT": "Unhealthy",
    "SANGAT TIDAK SEHAT": "Very Unhealthy",
    "BERBAHAYA": "Hazardous",
    "TIDAK ADA DATA": "No data",
}

DISCLAIMERS = [
    "Research demonstrator for Jakarta MORNING air quality (pre-dawn anchor + commute hours); "
    "the afternoon peak is out of scope by design.",
    "Forecasts are per H3 hex cell on the mainland-DKI grid, in 3-hour steps (now, +3h, +6h).",
    "Ground truth is only 5 DKI monitoring stations, so OFF-station (per-cell) accuracy is NOT "
    "independently validatable - per-cell differences are an informed display gradient, not a "
    "measured value. A real deployment must state this.",
]

PENDING_NOTE = (
    "Model output is being re-trained (pm25_conc target). Forecast values are not yet "
    "published - the map and location tools work, but per-cell values show "
    "'awaiting model output'."
)
LIVE_NOTE = "Forecast from the trained ST-GCN model (morning window, 3-hour steps)."


# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
def _grid_path(res: int) -> Path:
    """Locate the r{res} hex grid: prefer the local working copy (where NB1C
    writes), then fall back to the '1C static' upstream mirror. Works on both
    the local machine and Kaggle."""
    name = paths.hex_grid_name(res)
    candidates = [Path(paths.WORKING_ROOT) / "hex_grids" / name]
    try:
        candidates.append(Path(paths.upstream_dir("static", "jakarta_data", "hex_grids", name)))
    except Exception:
        pass
    for c in candidates:
        if c.exists():
            return c
    raise FileNotFoundError(
        f"hex_grid for r{res} not found. Looked in:\n  " + "\n  ".join(str(c) for c in candidates)
    )


def build_legend() -> list[dict]:
    """Rich colour-scale legend straight from physics.py (single source of truth)."""
    legend = []
    for upper, cat in ISPU_INDEX_CATEGORY:
        legend.append(
            {
                "category": cat,
                "english": CATEGORY_ENGLISH.get(cat, cat.title()),
                "upper": None if math.isinf(upper) else upper,
                "color": ISPU_CATEGORY_COLOR[cat],
            }
        )
    return legend


def _round_coords(obj, ndigits: int):
    """Recursively round every number in a GeoJSON coordinate tree."""
    if isinstance(obj, float):
        return round(obj, ndigits)
    if isinstance(obj, list):
        return [_round_coords(x, ndigits) for x in obj]
    return obj


def write_geojson(gdf, res: int) -> int:
    geojson = json.loads(gdf.to_json(drop_id=True))
    for feat in geojson["features"]:
        feat["geometry"]["coordinates"] = _round_coords(
            feat["geometry"]["coordinates"], COORD_NDIGITS
        )
    out = OUT_DIR / f"hexes_r{res}.geojson"
    out.write_text(json.dumps(geojson, separators=(",", ":")), encoding="utf-8")
    print(f"[build] wrote {out.name} ({out.stat().st_size / 1e3:.0f} KB, {len(geojson['features'])} cells)")
    return len(geojson["features"])


def load_nb8_forecast(res: int, grid_ids: set) -> tuple[dict, str | None]:
    """Read NB8's canonical web_data/forecast_r{res}.json and keep only the cells
    that exist on the current grid (drops stale-grid cells). NB8 emits the flat
    shape { h3_id: [ {offset_h, value, category, colour} ] } which is exactly the
    per-cell series the frontend wants."""
    nb8 = Path(paths.WORKING_ROOT) / "web_data" / f"forecast_r{res}.json"
    if not nb8.exists():
        raise FileNotFoundError(
            f"--mode live needs NB8 output at {nb8} (run NB8 inference + mirror it)."
        )
    raw = json.loads(nb8.read_text(encoding="utf-8"))
    anchor = None
    nb8_meta = Path(paths.WORKING_ROOT) / "web_data" / "meta.json"
    if nb8_meta.exists():
        anchor = json.loads(nb8_meta.read_text(encoding="utf-8")).get("anchor_ts")
    cells = {hid: series for hid, series in raw.items() if hid in grid_ids}
    dropped = len(raw) - len(cells)
    if dropped:
        print(f"[build] live: kept {len(cells)} cells, dropped {dropped} not on the r{res} grid")
    return cells, anchor


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="Build the static Jakarta-AQI web data.")
    ap.add_argument(
        "--mode",
        choices=["pending", "live"],
        default="pending",
        help="pending = coming-soon (empty forecast); live = read NB8's real forecast.",
    )
    ap.add_argument("--resolution", type=int, default=7, help="H3 resolution (default 7).")
    args = ap.parse_args()
    res = args.resolution

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    grid_path = _grid_path(res)
    print(f"[build] grid: {grid_path}")
    gdf = gpd.read_parquet(grid_path)
    keep = [c for c in ("h3_id", "center_lat", "center_lon", "geometry") if c in gdf.columns]
    gdf = gdf[keep].copy()
    print(f"[build] r{res}: {len(gdf)} grid cells, cols={keep}")

    n_geo = write_geojson(gdf, res)
    grid_ids = set(gdf["h3_id"])

    if args.mode == "live":
        cells, anchor = load_nb8_forecast(res, grid_ids)
        model_status = "live"
        model_note = LIVE_NOTE
    else:
        cells, anchor = {}, None
        model_status = "pending_retrain"
        model_note = PENDING_NOTE

    # --- Per-cell forecast (frontend contract) ---
    forecast = {
        "model_status": model_status,
        "anchor_ts": anchor,
        "resolution": res,
        "horizons_h": HORIZONS_H,
        "cells": cells,
    }
    fpath = OUT_DIR / f"forecast_r{res}.json"
    fpath.write_text(json.dumps(forecast, separators=(",", ":")), encoding="utf-8")
    print(f"[build] wrote {fpath.name} ({len(cells)} forecast cells, status={model_status})")

    # --- Meta (legend + status + disclaimers) ---
    meta = {
        "resolution": res,
        "model_status": model_status,
        "model_note": model_note,
        "anchor_ts": anchor,
        "horizons_h": HORIZONS_H,
        "has_plus_9h": False,
        "n_cells": n_geo,
        "n_forecast_cells": len(cells),
        "legend": build_legend(),
        "category_legend": {cat: ISPU_CATEGORY_COLOR[cat] for cat in constants.ISPU_CATEGORY_ORDER},
        "category_order": constants.ISPU_CATEGORY_ORDER,
        "no_data_color": ISPU_CATEGORY_COLOR["TIDAK ADA DATA"],
        "disclaimers": DISCLAIMERS,
    }
    mpath = OUT_DIR / "meta.json"
    mpath.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"[build] wrote {mpath.name} (status={model_status}, {n_geo} cells)")
    print("[build] done.")


if __name__ == "__main__":
    main()
