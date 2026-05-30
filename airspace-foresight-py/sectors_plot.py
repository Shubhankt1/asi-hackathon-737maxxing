#!/usr/bin/env python3
"""Visualize hackathon_data_bundle/sectors.geojson.

The file holds 712 airspace sectors over the continental US, split into two
altitude bands:
    LOW_*   0 - 35,000 ft
    HIGH_*  35,000 - 60,000 ft
Each sector is a simple Polygon with a `capacity` value (20-60).

The two bands cover the same geography, so we draw them in side-by-side
panels, each polygon shaded by its capacity. No shapely/geopandas needed:
GeoJSON polygon rings are plain coordinate lists.

Usage:
    .venv/bin/python sectors_plot.py            # show interactively
    .venv/bin/python sectors_plot.py --save out.png
"""
import argparse
import json
import os

import matplotlib
import matplotlib.pyplot as plt
from matplotlib.collections import PatchCollection
from matplotlib.patches import Polygon as MplPoly

HERE = os.path.dirname(os.path.abspath(__file__))
GEOJSON = os.path.join(HERE, "hackathon_data_bundle", "sectors.geojson")

BANDS = [
    ("LOW_", "LOW band  (0 - 35,000 ft)"),
    ("HIGH_", "HIGH band  (35,000 - 60,000 ft)"),
]


def load_features(path):
    with open(path) as fh:
        data = json.load(fh)
    return data["features"]


def patch_for(feature):
    """Build a matplotlib polygon patch from a GeoJSON Polygon (outer ring)."""
    outer_ring = feature["geometry"]["coordinates"][0]
    return MplPoly(outer_ring)


def draw_band(ax, features, prefix, title):
    selected = [f for f in features if f["properties"]["name"].startswith(prefix)]
    patches = [patch_for(f) for f in selected]
    capacities = [f["properties"]["capacity"] for f in selected]

    pc = PatchCollection(patches, cmap="viridis", alpha=0.75,
                         edgecolor="white", linewidth=0.3)
    pc.set_array(capacities)
    ax.add_collection(pc)
    ax.autoscale()
    ax.set_aspect("equal")
    ax.set_xlabel("Longitude")
    ax.set_ylabel("Latitude")
    ax.set_title(f"{title}  -  {len(selected)} sectors")
    return pc


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--save", metavar="PATH",
                        help="write the figure to PATH instead of showing a window")
    args = parser.parse_args()

    if args.save:
        matplotlib.use("Agg")

    features = load_features(GEOJSON)

    fig, axes = plt.subplots(1, 2, figsize=(18, 8), sharex=True, sharey=True)
    last_pc = None
    for ax, (prefix, title) in zip(axes, BANDS):
        last_pc = draw_band(ax, features, prefix, title)

    cbar = fig.colorbar(last_pc, ax=axes, fraction=0.025, pad=0.02)
    cbar.set_label("Sector capacity")
    fig.suptitle("Airspace sectors by altitude band, shaded by capacity",
                 fontsize=15)

    if args.save:
        fig.savefig(args.save, dpi=130, bbox_inches="tight")
        print(f"Saved figure to {args.save}")
    else:
        plt.show()


if __name__ == "__main__":
    main()
