#!/usr/bin/env python3
"""Interactive visualization of the `asked_at_*` snapshots.

Each `asked_at_<timestamp>` folder is one snapshot of the US air-traffic
system at a moment in time:

  * routes.json     - every flight scheduled in a time window, with its
                      planned waypoint path (lats/lons), cruise altitude,
                      take-off and landing times.
  * wx/refc/*.npz   - composite reflectivity (precip intensity, dBZ),
  * wx/retop/*.npz  - echo top (storm-top altitude, ft),
                      as 73 consecutive 15-minute forecast strips reaching
                      ~18 hours forward from the snapshot.

This builds a single animated Plotly map with a time slider: the weather
forecast plays forward in time while every airborne aircraft moves along
its planned route, colored by cruise altitude. Flights are placed by
interpolating along their waypoints, assuming constant-speed cruise between
take-off and landing (per the dataset's modelling assumptions).

Usage:
    .venv/bin/python routes_wx_plot.py
    .venv/bin/python routes_wx_plot.py --asked-at 2025-08-13 --field refc
    .venv/bin/python routes_wx_plot.py --frame-stride 1 --max-flights 6000

Output: a self-contained HTML file (opened in your browser by default).
"""
import argparse
import glob
import json
import os
from datetime import datetime

import numpy as np
import plotly.graph_objects as go

# --- Weather grid georeferencing (from documentation/wx/FILE_FORMAT.md) ---
LAT_MIN, LAT_MAX = 21.943, 55.7765
LON_MIN, LON_MAX = -135.0, -67.5
ROWS, COLS = 256, 358

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "hackathon_data_bundle")

# Map view roughly covering the continental US (where the data lives).
VIEW_CENTER = dict(lat=39.0, lon=-96.0)
VIEW_ZOOM = 2.6


# --------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------
def find_snapshot(substr):
    """Return the asked_at directory whose name contains `substr`."""
    matches = sorted(glob.glob(os.path.join(BUNDLE, "asked_at_*" + "*")))
    matches = [m for m in matches if os.path.isdir(m) and substr in os.path.basename(m)]
    if not matches:
        avail = [os.path.basename(p) for p in
                 sorted(glob.glob(os.path.join(BUNDLE, "asked_at_*"))) if os.path.isdir(p)]
        raise SystemExit(f"No asked_at folder matching {substr!r}.\nAvailable:\n  " +
                         "\n  ".join(avail))
    return matches[0]


def parse_iso(s):
    return datetime.fromisoformat(s)


def strip_valid_from(path):
    """Filename is based_at_validfrom_validto.npz with '_' between the three
    'YYYY-MM-DD_HH:MM:SS' timestamps -> the 2nd timestamp is valid_from."""
    stem = os.path.basename(path)[:-4]            # drop .npz
    parts = stem.split("_")                       # 6 parts: date,time x3
    valid_from = parts[2] + "_" + parts[3]
    return datetime.strptime(valid_from, "%Y-%m-%d_%H:%M:%S")


def load_weather(snapshot_dir, field, stride):
    paths = sorted(glob.glob(os.path.join(snapshot_dir, "wx", field, "*.npz")))
    if not paths:
        raise SystemExit(f"No {field} npz files under {snapshot_dir}/wx/{field}")
    paths = paths[::stride]
    frames = []
    for p in paths:
        m = np.load(p)["matrix"]
        frames.append((strip_valid_from(p), m))
    frames.sort(key=lambda t: t[0])
    return frames


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------
def grid_latlon():
    """Center lat/lon of every grid cell, as 2D arrays."""
    i = np.arange(ROWS) + 0.5
    j = np.arange(COLS) + 0.5
    lat = LAT_MAX - i / ROWS * (LAT_MAX - LAT_MIN)
    lon = LON_MIN + j / COLS * (LON_MAX - LON_MIN)
    lon2d, lat2d = np.meshgrid(lon, lat)
    return lat2d, lon2d


def haversine_cumdist(lats, lons):
    """Cumulative great-circle distance (normalized 0..1) along a polyline."""
    lat = np.radians(lats)
    lon = np.radians(lons)
    dlat = np.diff(lat)
    dlon = np.diff(lon)
    a = np.sin(dlat / 2) ** 2 + np.cos(lat[:-1]) * np.cos(lat[1:]) * np.sin(dlon / 2) ** 2
    seg = 2 * np.arcsin(np.sqrt(np.clip(a, 0, 1)))
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    total = cum[-1]
    if total <= 0:
        return np.linspace(0, 1, len(lats))
    return cum / total


def build_flight_index(flights):
    """Precompute per-flight arrays for fast position interpolation."""
    idx = []
    for f in flights:
        lats = np.asarray(f["lats"], dtype=float)
        lons = np.asarray(f["lons"], dtype=float)
        if len(lats) < 2:
            continue
        t0 = parse_iso(f["take_off_time"]).timestamp()
        t1 = parse_iso(f["scheduled_landing_time"]).timestamp()
        if t1 <= t0:
            continue
        idx.append(dict(
            lats=lats, lons=lons,
            cum=haversine_cumdist(lats, lons),
            t0=t0, t1=t1,
            alt=f["cruise_altitude_ft"],
            label=f"{f['flight_number']}  {f['origin_airport_icao']}→"
                  f"{f['destination_airport_icao']}  FL{f['cruise_altitude_ft']//100:03d}",
        ))
    return idx


def positions_at(flight_idx, t_epoch):
    """Airborne aircraft positions at time `t_epoch` (unix seconds)."""
    lat, lon, alt, text = [], [], [], []
    for fl in flight_idx:
        if not (fl["t0"] <= t_epoch < fl["t1"]):
            continue
        frac = (t_epoch - fl["t0"]) / (fl["t1"] - fl["t0"])
        plat = np.interp(frac, fl["cum"], fl["lats"])
        plon = np.interp(frac, fl["cum"], fl["lons"])
        lat.append(plat)
        lon.append(plon)
        alt.append(fl["alt"])
        text.append(fl["label"])
    return lat, lon, alt, text


# --------------------------------------------------------------------------
# Weather -> point cloud (thresholded, downsampled for a light HTML)
# --------------------------------------------------------------------------
def weather_points(matrix, field, threshold, downsample, lat2d, lon2d):
    if field == "refc":
        valid = matrix > threshold            # dBZ above precip threshold
    else:                                     # retop: feet, mask negatives
        valid = matrix > max(threshold, 0.0)
    sub = (slice(None, None, downsample), slice(None, None, downsample))
    vmask = valid[sub]
    return (lat2d[sub][vmask], lon2d[sub][vmask], matrix[sub][vmask])


# --------------------------------------------------------------------------
# Figure
# --------------------------------------------------------------------------
def build_figure(snapshot_dir, field, frame_stride, wx_threshold, downsample,
                 max_flights, route_sample):
    routes = json.load(open(os.path.join(snapshot_dir, "routes.json")))
    flights = routes["flights"]
    print(f"  flights in snapshot: {len(flights)}")

    if max_flights and len(flights) > max_flights:
        step = len(flights) / max_flights
        flights = [flights[int(i * step)] for i in range(max_flights)]
        print(f"  sampling {len(flights)} flights for animation")

    flight_idx = build_flight_index(flights)
    wx_frames = load_weather(snapshot_dir, field, frame_stride)
    print(f"  weather frames ({field}): {len(wx_frames)}")
    lat2d, lon2d = grid_latlon()

    if field == "refc":
        colorscale, cbar, vmin, vmax = "turbo", "Reflectivity (dBZ)", wx_threshold, 60
        wx_radius, wx_opacity = 12, 0.55
    else:
        colorscale, cbar, vmin, vmax = "Plasma", "Echo top (ft)", 0, 50000
        wx_radius, wx_opacity = 12, 0.55

    # Static context layer: faint planned routes (sampled).
    rlat, rlon = [], []
    sample_step = max(1, len(flight_idx) // max(1, route_sample))
    for fl in flight_idx[::sample_step]:
        rlat.extend(fl["lats"].tolist() + [None])
        rlon.extend(fl["lons"].tolist() + [None])

    def wx_trace(matrix):
        wlat, wlon, wval = weather_points(matrix, field, wx_threshold, downsample,
                                          lat2d, lon2d)
        return go.Densitymap(
            lat=wlat, lon=wlon, z=wval, radius=wx_radius,
            colorscale=colorscale, zmin=vmin, zmax=vmax, opacity=wx_opacity,
            colorbar=dict(title=cbar, x=0.99, len=0.8),
            hoverinfo="skip", name=field,
        )

    def flight_trace(t_epoch):
        flat, flon, falt, ftext = positions_at(flight_idx, t_epoch)
        return go.Scattermap(
            lat=flat, lon=flon, mode="markers",
            marker=dict(size=5, color=falt, colorscale="Viridis",
                        cmin=0, cmax=45000, opacity=0.9),
            text=ftext, hoverinfo="text", name="aircraft",
        )

    t_epochs = [vf.timestamp() for vf, _ in wx_frames]

    # Base traces (first frame) + static routes underneath.
    base_routes = go.Scattermap(
        lat=rlat, lon=rlon, mode="lines",
        line=dict(width=0.5, color="rgba(70,70,90,0.25)"),
        hoverinfo="skip", name="planned routes",
    )
    fig = go.Figure(data=[base_routes, wx_trace(wx_frames[0][1]),
                          flight_trace(t_epochs[0])])

    frames = []
    for (vf, matrix), t in zip(wx_frames, t_epochs):
        n_air = sum(1 for fl in flight_idx if fl["t0"] <= t < fl["t1"])
        frames.append(go.Frame(
            name=vf.strftime("%m-%d %H:%M"),
            data=[wx_trace(matrix), flight_trace(t)],
            traces=[1, 2],  # update weather + aircraft; leave routes (0) static
            layout=go.Layout(title=dict(text=base_title(snapshot_dir, field) +
                                        f"  |  valid {vf.strftime('%Y-%m-%d %H:%M')}Z"
                                        f"  |  {n_air} airborne")),
        ))
    fig.frames = frames

    steps = [dict(method="animate", label=fr.name,
                  args=[[fr.name], dict(mode="immediate",
                                        frame=dict(duration=0, redraw=True),
                                        transition=dict(duration=0))])
             for fr in frames]

    fig.update_layout(
        title=base_title(snapshot_dir, field) +
              f"  |  valid {wx_frames[0][0].strftime('%Y-%m-%d %H:%M')}Z",
        map=dict(style="carto-positron", center=VIEW_CENTER, zoom=VIEW_ZOOM),
        margin=dict(l=0, r=0, t=60, b=0),
        legend=dict(x=0.01, y=0.99, bgcolor="rgba(255,255,255,0.6)"),
        updatemenus=[dict(
            type="buttons", direction="left", x=0.01, y=0.04, xanchor="left",
            pad=dict(r=8, t=4), bgcolor="rgba(255,255,255,0.7)",
            buttons=[
                dict(label="▶ Play", method="animate",
                     args=[None, dict(frame=dict(duration=350, redraw=True),
                                      fromcurrent=True,
                                      transition=dict(duration=0))]),
                dict(label="❚❚ Pause", method="animate",
                     args=[[None], dict(mode="immediate",
                                        frame=dict(duration=0, redraw=False))]),
            ],
        )],
        sliders=[dict(active=0, x=0.08, len=0.9, y=0.02,
                      currentvalue=dict(prefix="Forecast valid: "),
                      pad=dict(b=10, t=4), steps=steps)],
    )
    return fig


def base_title(snapshot_dir, field):
    name = os.path.basename(snapshot_dir).replace("asked_at_", "")
    label = "Composite reflectivity" if field == "refc" else "Echo top"
    return f"US flights + weather  —  snapshot {name}  —  {label}"


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--asked-at", default="2026-03-04",
                    help="substring of the asked_at folder to use")
    ap.add_argument("--field", choices=["refc", "retop"], default="refc",
                    help="weather field to animate (default: refc)")
    ap.add_argument("--frame-stride", type=int, default=2,
                    help="use every Nth forecast strip (default 2 -> ~37 frames)")
    ap.add_argument("--wx-threshold", type=float, default=20.0,
                    help="hide weather below this value (dBZ for refc)")
    ap.add_argument("--downsample", type=int, default=1,
                    help="weather grid downsample factor (1 = full resolution)")
    ap.add_argument("--max-flights", type=int, default=0,
                    help="max flights to animate (sampled; 0 = all, the default)")
    ap.add_argument("--route-sample", type=int, default=700,
                    help="number of planned routes to draw as faint context lines")
    ap.add_argument("--out", default=None, help="output HTML path")
    ap.add_argument("--no-open", action="store_true", help="don't open the browser")
    args = ap.parse_args()

    snapshot_dir = find_snapshot(args.asked_at)
    print(f"Snapshot: {os.path.basename(snapshot_dir)}")

    fig = build_figure(snapshot_dir, args.field, args.frame_stride,
                       args.wx_threshold, args.downsample,
                       args.max_flights, args.route_sample)

    out = args.out or os.path.join(
        HERE, f"viz_{os.path.basename(snapshot_dir)}_{args.field}.html")
    fig.write_html(out, include_plotlyjs="cdn", auto_open=not args.no_open)
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
