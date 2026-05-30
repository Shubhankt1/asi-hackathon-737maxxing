#!/usr/bin/env python3
"""FastAPI wrapper around the Airspace Foresight visualization.

A single route (``GET /``) builds the animated Plotly map — flights + weather
with the click-to-reroute A*/Theta* tooling — and returns it as a
self-contained HTML page. Every build option from the CLI is exposed as an
optional query parameter, so plain ``GET /`` reproduces the default figure.

Run:
    .venv/bin/python app.py
    # equivalently: .venv/bin/uvicorn app:app --host 127.0.0.1 --port 4000

Then open http://localhost:4000  (e.g. /?asked-at=2025-08-13&max_flights=4000).
"""
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
import uvicorn

from routes_wx_plot import build_figure, find_snapshot, reroute_post_script

app = FastAPI(title="Airspace Foresight", version="1.0")


@app.get("/", response_class=HTMLResponse)
def visualization(
    asked_at: str = Query("2026-03-04", description="substring of the asked_at snapshot folder"),
    field: str = Query("refc", pattern="^(refc|retop)$", description="weather field to animate"),
    frame_stride: int = Query(2, ge=1, description="use every Nth forecast strip"),
    wx_threshold: float = Query(20.0, description="hide weather below this value"),
    downsample: int = Query(1, ge=1, description="weather grid downsample factor"),
    max_flights: int = Query(0, ge=0, description="max flights to animate (0 = all)"),
    route_sample: int = Query(700, ge=1, description="planned routes drawn as context"),
    reroute_downsample: int = Query(4, ge=1, description="hazard-grid downsample for reroute A*"),
    reroute: bool = Query(True, description="enable click-to-reroute tooling"),
):
    """Build and return the interactive visualization HTML for one snapshot."""
    try:
        snapshot_dir = find_snapshot(asked_at)
    except SystemExit as exc:                       # find_snapshot exits on no match
        raise HTTPException(status_code=404, detail=str(exc))

    fig, payload = build_figure(
        snapshot_dir, field, frame_stride, wx_threshold, downsample,
        max_flights, route_sample, reroute_downsample=reroute_downsample,
        enable_reroute=reroute,
    )
    post_script = reroute_post_script(payload) if payload else None
    html = fig.to_html(include_plotlyjs="cdn", full_html=True, post_script=post_script)
    return HTMLResponse(content=html)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=4000)
