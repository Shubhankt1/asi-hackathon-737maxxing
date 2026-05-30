#!/usr/bin/env python3
"""
prep_wx.py — convert the hackathon weather bundle into Node-readable assets.

For each snapshot directory (asked_at_<ts>) it:
  - copies routes.json
  - packs the refc / retop 15-min forecast strips into compact binaries
  - writes a manifest.json describing the strips + how to decode the binaries

It also copies sectors.geojson once into the output root.

Binary formats (row-major, strip-major; strip s starts at s*ROWS*COLS):
  refc_i8.bin   int8   value = round(dBZ), clamped [-50, 60]; nodata -> -128
  retop_u16.bin uint16 little-endian, value = feet clamped [0, 65000];
                nodata (retop < 0) and "no echo" both -> 0

Both collapse nodata to a value that reads as "no hazard", which is correct for
the hazard test (refc >= 40 dBZ AND retop >= flight altitude).

Usage:
  python3 prep/prep_wx.py                 # process all snapshots
  python3 prep/prep_wx.py asked_at_2025-05-29T21:00:00Z [more...]
"""
import sys, os, json, shutil, glob
import numpy as np

ROWS, COLS = 256, 358
LAT_MIN, LAT_MAX = 21.943, 55.7765
LON_MIN, LON_MAX = -135.0, -67.5

HERE = os.path.dirname(os.path.abspath(__file__))
BUNDLE = os.path.join(HERE, "..", "hackathon_data_bundle")
OUT = os.path.join(HERE, "..", "airspace-foresight-web-service", "data")


def parse_strip_name(fname):
    """`{based}_{from}_{to}.npz`, each ts = YYYY-MM-DD_HH:MM:SS -> 6 tokens."""
    stem = os.path.basename(fname)[:-4]  # drop .npz
    t = stem.split("_")
    if len(t) != 6:
        raise ValueError(f"unexpected strip name: {fname}")
    based = f"{t[0]}T{t[1]}Z"
    vfrom = f"{t[2]}T{t[3]}Z"
    vto = f"{t[4]}T{t[5]}Z"
    return based, vfrom, vto


def load_grid(path):
    return np.load(path)["matrix"]  # (256, 358) float64


def process_snapshot(snap_dir):
    name = os.path.basename(snap_dir.rstrip("/"))
    out_dir = os.path.join(OUT, "snapshots", name)
    wx_out = os.path.join(out_dir, "wx")
    os.makedirs(wx_out, exist_ok=True)

    # routes.json (bundle has it plain; copy as-is)
    src_routes = os.path.join(snap_dir, "routes.json")
    if os.path.exists(src_routes):
        shutil.copyfile(src_routes, os.path.join(out_dir, "routes.json"))

    refc_files = sorted(glob.glob(os.path.join(snap_dir, "wx", "refc", "*.npz")))
    retop_files = sorted(glob.glob(os.path.join(snap_dir, "wx", "retop", "*.npz")))

    # Index strips by valid_from so refc/retop align and walk forward in time.
    strips = {}
    for f in refc_files:
        based, vf, vt = parse_strip_name(f)
        strips.setdefault(vf, {})["refc"] = f
        strips[vf].update(based_at=based, valid_from=vf, valid_to=vt)
    for f in retop_files:
        based, vf, vt = parse_strip_name(f)
        strips.setdefault(vf, {})["retop"] = f
        strips[vf].update(based_at=based, valid_from=vf, valid_to=vt)

    ordered = [strips[k] for k in sorted(strips.keys())]

    refc_buf = np.empty((len(ordered), ROWS, COLS), dtype=np.int8)
    retop_buf = np.empty((len(ordered), ROWS, COLS), dtype=np.uint16)

    manifest_strips = []
    for i, s in enumerate(ordered):
        # refc -> int8
        if "refc" in s:
            m = load_grid(s["refc"])
            v = np.where(m <= -50, -128, np.clip(np.round(m), -50, 60)).astype(np.int8)
        else:
            v = np.full((ROWS, COLS), -128, dtype=np.int8)
        refc_buf[i] = v
        # retop -> uint16 feet
        if "retop" in s:
            m = load_grid(s["retop"])
            v = np.where(m < 0, 0, np.clip(np.round(m), 0, 65000)).astype(np.uint16)
        else:
            v = np.zeros((ROWS, COLS), dtype=np.uint16)
        retop_buf[i] = v

        manifest_strips.append({
            "index": i,
            "based_at": s.get("based_at"),
            "valid_from": s["valid_from"],
            "valid_to": s["valid_to"],
        })

    refc_buf.tofile(os.path.join(wx_out, "refc_i8.bin"))
    # ensure little-endian on disk regardless of host
    retop_buf.astype("<u2").tofile(os.path.join(wx_out, "retop_u16.bin"))

    manifest = {
        "snapshot": name,
        "grid": {"rows": ROWS, "cols": COLS,
                 "lat_min": LAT_MIN, "lat_max": LAT_MAX,
                 "lon_min": LON_MIN, "lon_max": LON_MAX},
        "refc": {"file": "refc_i8.bin", "dtype": "int8",
                 "nodata": -128, "hazard_min_dbz": 40},
        "retop": {"file": "retop_u16.bin", "dtype": "uint16_le",
                  "units": "feet", "nodata": 0},
        "n_strips": len(ordered),
        "strips": manifest_strips,
    }
    with open(os.path.join(wx_out, "manifest.json"), "w") as fh:
        json.dump(manifest, fh)

    nbytes = refc_buf.nbytes + retop_buf.nbytes
    print(f"  {name}: {len(ordered)} strips, wx {nbytes/1e6:.1f} MB")
    return manifest


def main():
    os.makedirs(OUT, exist_ok=True)

    # sectors once
    src_sectors = os.path.join(BUNDLE, "sectors.geojson")
    if os.path.exists(src_sectors):
        shutil.copyfile(src_sectors, os.path.join(OUT, "sectors.geojson"))
        print(f"copied sectors.geojson")

    args = sys.argv[1:]
    if args:
        snap_dirs = [os.path.join(BUNDLE, a) for a in args]
    else:
        snap_dirs = sorted(glob.glob(os.path.join(BUNDLE, "asked_at_*")))

    index = []
    for d in snap_dirs:
        if not os.path.isdir(d):
            print(f"skip (not a dir): {d}")
            continue
        print(f"processing {os.path.basename(d)} ...")
        m = process_snapshot(d)
        index.append({"snapshot": m["snapshot"], "n_strips": m["n_strips"]})

    # merge into a top-level snapshots index (so re-running one snapshot keeps others)
    idx_path = os.path.join(OUT, "snapshots", "index.json")
    existing = {}
    if os.path.exists(idx_path):
        try:
            for e in json.load(open(idx_path)).get("snapshots", []):
                existing[e["snapshot"]] = e
        except Exception:
            pass
    for e in index:
        existing[e["snapshot"]] = e
    os.makedirs(os.path.dirname(idx_path), exist_ok=True)
    with open(idx_path, "w") as fh:
        json.dump({"snapshots": sorted(existing.values(), key=lambda x: x["snapshot"])}, fh, indent=1)
    print(f"wrote index with {len(existing)} snapshot(s)")


if __name__ == "__main__":
    main()
