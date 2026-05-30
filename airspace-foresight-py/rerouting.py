#!/usr/bin/env python3
"""Weather-aware aircraft rerouting.

This module is the *reference* routing core. It is deliberately decoupled from
the Plotly visualization so it can be unit-tested on its own and so additional
algorithms can be dropped in later without touching the rest of the codebase.

Pieces
------
* ``haversine_km``      - great-circle distance between two lat/lon points.
* ``HazardGrid``        - the weather forecast (composite reflectivity) reduced
                          to a coarse per-frame cost field over the CONUS grid,
                          with lat/lon <-> cell conversions.
* ``Router`` (ABC)      - the routing interface. ``route(start, goal, grid,
                          frame)`` returns a list of ``(lat, lon)`` waypoints.
* ``AStarRouter``       - A* over the hazard grid: step cost is the haversine
                          distance between cell centers, multiplied by a weather
                          penalty, with a straight-line (haversine) heuristic.
* ``REROUTERS``         - name -> Router registry. Start with ``"astar"``; add
                          more (``"dijkstra"``, ``"thetastar"``, ...) here.

The browser visualization ships a faithful JavaScript port of ``AStarRouter``
so the reroute can run interactively on click; keep the two in sync (the
penalty constants are exported via :func:`router_config` so they share one
source of truth).
"""
from __future__ import annotations

import heapq
import math
from abc import ABC, abstractmethod

import numpy as np

# --- Weather grid georeferencing (from documentation/wx/FILE_FORMAT.md) ---
LAT_MIN, LAT_MAX = 21.943, 55.7765
LON_MIN, LON_MAX = -135.0, -67.5
ROWS, COLS = 256, 358

# Per the dataset docs, composite reflectivity >= 40 dBZ is weather that
# actually affects a flight; below that is fine.
HAZARD_DBZ = 40.0

# Weather penalty applied to each A* step, as a multiplier on distance:
#   multiplier(dbz) = 1                       for dbz <= 0   (clear air)
#                   = 1 + SOFT_PENALTY * dbz  for 0 < dbz < HAZARD_DBZ
#                   = HARD_PENALTY            for dbz >= HAZARD_DBZ
# A large-but-finite HARD_PENALTY makes storms strongly avoided while keeping
# the graph connected (a fully boxed-in aircraft still gets *a* path).
SOFT_PENALTY = 0.08
HARD_PENALTY = 50.0

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometers between two lat/lon points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(min(1.0, a)))


def hazard_multiplier(dbz: float,
                      hazard_dbz: float = HAZARD_DBZ,
                      soft: float = SOFT_PENALTY,
                      hard: float = HARD_PENALTY) -> float:
    """Distance multiplier for traversing a cell of intensity ``dbz``."""
    if dbz >= hazard_dbz:
        return hard
    if dbz <= 0.0:
        return 1.0
    return 1.0 + soft * dbz


# --------------------------------------------------------------------------
# Hazard grid
# --------------------------------------------------------------------------
class HazardGrid:
    """Coarse, per-forecast-frame weather cost field over the CONUS grid.

    ``layers[f]`` is an ``(rows, cols)`` int array of composite reflectivity
    (dBZ, clamped to >= 0; nodata treated as clear) after block-max
    downsampling by ``downsample``. Block-*max* is deliberately conservative:
    a coarse cell is as hazardous as the worst pixel it covers.

    The coarse grid keeps the original bounding box, so it is itself a regular
    equirectangular grid and lat/lon <-> cell math is the same formula as the
    full-resolution grid, just with smaller ``rows``/``cols``.
    """

    def __init__(self, layers, *, downsample,
                 lat_min=LAT_MIN, lat_max=LAT_MAX,
                 lon_min=LON_MIN, lon_max=LON_MAX,
                 hazard_dbz=HAZARD_DBZ, names=None):
        self.layers = [np.asarray(l) for l in layers]
        self.rows, self.cols = self.layers[0].shape
        self.downsample = downsample
        self.lat_min, self.lat_max = lat_min, lat_max
        self.lon_min, self.lon_max = lon_min, lon_max
        self.hazard_dbz = hazard_dbz
        self.names = list(names) if names is not None else None

    # -- construction --
    @classmethod
    def from_frames(cls, wx_frames, *, downsample=4, hazard_dbz=HAZARD_DBZ):
        """Build from ``[(valid_from, matrix), ...]`` weather frames.

        ``matrix`` is the raw (256, 358) refc array; nodata (<= -50) and
        negative dBZ become 0 (clear air)."""
        layers, names = [], []
        for vf, matrix in wx_frames:
            layers.append(cls._block_max_downsample(matrix, downsample))
            names.append(vf.strftime("%m-%d %H:%M") if hasattr(vf, "strftime") else str(vf))
        return cls(layers, downsample=downsample, hazard_dbz=hazard_dbz, names=names)

    @staticmethod
    def _block_max_downsample(matrix, d):
        m = np.asarray(matrix, dtype=float)
        m = np.where(m <= -50.0, 0.0, m)          # nodata -> clear
        m = np.clip(m, 0.0, 80.0)                  # negatives -> clear, cap high
        if d <= 1:
            return np.rint(m).astype(np.int16)
        r, c = m.shape
        pr = (-r) % d
        pc = (-c) % d
        if pr or pc:                               # pad to a multiple of d with 0
            m = np.pad(m, ((0, pr), (0, pc)), constant_values=0.0)
        R, C = m.shape[0] // d, m.shape[1] // d
        block = m.reshape(R, d, C, d).max(axis=(1, 3))
        return np.rint(block).astype(np.int16)

    # -- geometry --
    def cell_center(self, i: int, j: int) -> tuple[float, float]:
        lat = self.lat_max - (i + 0.5) / self.rows * (self.lat_max - self.lat_min)
        lon = self.lon_min + (j + 0.5) / self.cols * (self.lon_max - self.lon_min)
        return lat, lon

    def latlon_to_cell(self, lat: float, lon: float) -> tuple[int, int]:
        i = int((self.lat_max - lat) / (self.lat_max - self.lat_min) * self.rows)
        j = int((lon - self.lon_min) / (self.lon_max - self.lon_min) * self.cols)
        i = min(max(i, 0), self.rows - 1)
        j = min(max(j, 0), self.cols - 1)
        return i, j

    def dbz_at(self, frame: int, i: int, j: int) -> float:
        return float(self.layers[frame][i, j])

    # -- export for the browser port --
    def to_dict(self) -> dict:
        """JSON-serializable payload for the embedded JavaScript A*."""
        return dict(
            rows=self.rows, cols=self.cols, downsample=self.downsample,
            lat_min=self.lat_min, lat_max=self.lat_max,
            lon_min=self.lon_min, lon_max=self.lon_max,
            hazard_dbz=self.hazard_dbz,
            names=self.names,
            layers=[l.astype(int).ravel().tolist() for l in self.layers],
        )


# --------------------------------------------------------------------------
# Routers
# --------------------------------------------------------------------------
class Router(ABC):
    """A reroute strategy. Subclass and register in :data:`REROUTERS`."""

    name: str = "router"

    @abstractmethod
    def route(self, start: tuple[float, float], goal: tuple[float, float],
              grid: HazardGrid, frame: int = 0) -> list[tuple[float, float]]:
        """Return a polyline of ``(lat, lon)`` waypoints from ``start`` to
        ``goal`` that avoids weather in ``grid.layers[frame]``."""
        raise NotImplementedError


# 8-connected neighborhood.
_NEIGHBORS = [(-1, -1), (-1, 0), (-1, 1),
              (0, -1),           (0, 1),
              (1, -1),  (1, 0),  (1, 1)]


class AStarRouter(Router):
    """A* search over the hazard grid.

    Step cost = haversine(cellA_center, cellB_center) * hazard_multiplier(dbz
    of cellB). Heuristic = haversine straight-line distance to the goal cell,
    which is admissible because every step's multiplier is >= 1.
    """

    name = "astar"

    def __init__(self, hazard_dbz=HAZARD_DBZ, soft=SOFT_PENALTY, hard=HARD_PENALTY):
        self.hazard_dbz = hazard_dbz
        self.soft = soft
        self.hard = hard

    def route(self, start, goal, grid: HazardGrid, frame: int = 0):
        layer = grid.layers[frame]
        rows, cols = grid.rows, grid.cols
        si, sj = grid.latlon_to_cell(*start)
        gi, gj = grid.latlon_to_cell(*goal)
        goal_lat, goal_lon = grid.cell_center(gi, gj)

        def h(i, j):
            lat, lon = grid.cell_center(i, j)
            return haversine_km(lat, lon, goal_lat, goal_lon)

        start_id = si * cols + sj
        goal_id = gi * cols + gj
        g_score = {start_id: 0.0}
        came_from: dict[int, int] = {}
        open_heap = [(h(si, sj), start_id)]
        closed = set()

        while open_heap:
            _, cur = heapq.heappop(open_heap)
            if cur == goal_id:
                break
            if cur in closed:
                continue
            closed.add(cur)
            ci, cj = divmod(cur, cols)
            clat, clon = grid.cell_center(ci, cj)
            for di, dj in _NEIGHBORS:
                ni, nj = ci + di, cj + dj
                if not (0 <= ni < rows and 0 <= nj < cols):
                    continue
                nid = ni * cols + nj
                if nid in closed:
                    continue
                nlat, nlon = grid.cell_center(ni, nj)
                step = haversine_km(clat, clon, nlat, nlon)
                mult = hazard_multiplier(float(layer[ni, nj]),
                                         self.hazard_dbz, self.soft, self.hard)
                tentative = g_score[cur] + step * mult
                if tentative < g_score.get(nid, math.inf):
                    came_from[nid] = cur
                    g_score[nid] = tentative
                    heapq.heappush(open_heap, (tentative + h(ni, nj), nid))

        if goal_id not in came_from and goal_id != start_id:
            return [tuple(start), tuple(goal)]      # no path: straight fallback

        # Reconstruct cell path, then pin exact start/goal endpoints.
        cells = [goal_id]
        while cells[-1] in came_from:
            cells.append(came_from[cells[-1]])
        cells.reverse()
        path = [grid.cell_center(*divmod(c, cols)) for c in cells]
        return [tuple(start)] + path + [tuple(goal)]


# name -> Router instance. Register new strategies here; the visualization
# exposes every key in this registry as a selectable algorithm.
REROUTERS: dict[str, Router] = {
    AStarRouter.name: AStarRouter(),
}


def get_router(name: str = "astar") -> Router:
    if name not in REROUTERS:
        raise KeyError(f"unknown router {name!r}; available: {sorted(REROUTERS)}")
    return REROUTERS[name]


def router_config(hazard_dbz=HAZARD_DBZ, soft=SOFT_PENALTY, hard=HARD_PENALTY) -> dict:
    """Penalty constants shared with the browser A* port (single source of
    truth so the Python and JavaScript searches behave identically)."""
    return dict(hazard_dbz=hazard_dbz, soft=soft, hard=hard,
                routers=list(REROUTERS.keys()))


# --------------------------------------------------------------------------
# Smoke test: build a synthetic storm wall and confirm A* routes around it.
# --------------------------------------------------------------------------
if __name__ == "__main__":
    rows = full = np.zeros((ROWS, COLS))
    # A vertical wall of severe weather with a gap, sitting between two points.
    full[:, 170:176] = 55.0
    full[40:90, 170:176] = 0.0                     # leave a clear gap
    grid = HazardGrid([full], downsample=4)
    router = get_router("astar")
    # Two points on opposite sides of the wall.
    start = grid.cell_center(60, 120)
    goal = grid.cell_center(60, 250)
    path = router.route(start, goal, grid, 0)
    # Verify no waypoint sits inside a >=40 dBZ cell.
    worst = max(grid.dbz_at(0, *grid.latlon_to_cell(la, lo)) for la, lo in path)
    print(f"router={router.name} waypoints={len(path)} worst_dbz_on_path={worst:.0f}")
    assert worst < grid.hazard_dbz, "A* routed through a storm!"
    print("OK: A* avoided the storm wall.")
