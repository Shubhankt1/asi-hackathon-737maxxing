// Weather-aware reroute search over a HazardGrid.
//
// A faithful server-side port of the reference routers in airspace-foresight-py:
//   - aStar      mirrors rerouting.AStarRouter.route
//   - thetaStar  mirrors the any-angle search embedded in routes_wx_plot.py
//   - hazardMultiplier / haversineKm mirror rerouting.hazard_multiplier / haversine_km
// Step cost = haversine(cellA, cellB) * hazardMultiplier(dbz of cellB);
// heuristic = straight-line haversine to the goal (admissible since every
// multiplier is >= 1). REROUTERS is a name->fn registry so a new algorithm is
// one entry.

import {
  EARTH_RADIUS_KM,
  HAZARD_DBZ,
  HARD_PENALTY,
  HazardGrid,
  SOFT_PENALTY,
} from "./hazardGrid.js";

export type LatLon = [number, number];
export type RouteFn = (start: LatLon, goal: LatLon, grid: HazardGrid) => LatLon[];

const RAD = Math.PI / 180;

export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const p1 = lat1 * RAD;
  const p2 = lat2 * RAD;
  const dphi = (lat2 - lat1) * RAD;
  const dlmb = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(Math.min(1, a)));
}

export function hazardMultiplier(dbz: number): number {
  if (dbz >= HAZARD_DBZ) return HARD_PENALTY;
  if (dbz <= 0) return 1.0;
  return 1.0 + SOFT_PENALTY * dbz;
}

// Minimal binary min-heap keyed by f-score (mirrors the JS Heap in
// routes_wx_plot.py). Entries are [f, cellId].
class Heap {
  private a: [number, number][] = [];
  size(): number {
    return this.a.length;
  }
  push(f: number, id: number): void {
    const a = this.a;
    a.push([f, id]);
    let k = a.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (a[p][0] <= a[k][0]) break;
      const t = a[p];
      a[p] = a[k];
      a[k] = t;
      k = p;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let k = 0;
      const n = a.length;
      while (true) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < n && a[l][0] < a[m][0]) m = l;
        if (r < n && a[r][0] < a[m][0]) m = r;
        if (m === k) break;
        const t = a[m];
        a[m] = a[k];
        a[k] = t;
        k = m;
      }
    }
    return top;
  }
}

// 8-connected neighborhood.
const NB: [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

/** A* over the hazard grid — mirrors rerouting.AStarRouter.route. */
export function aStar(start: LatLon, goal: LatLon, grid: HazardGrid): LatLon[] {
  const { rows, cols, layer } = grid;
  const [si, sj] = grid.latlonToCell(start[0], start[1]);
  const [gi, gj] = grid.latlonToCell(goal[0], goal[1]);
  const startId = si * cols + sj;
  const goalId = gi * cols + gj;
  const [goalLat, goalLon] = grid.cellCenter(gi, gj);
  const h = (i: number, j: number): number => {
    const [lat, lon] = grid.cellCenter(i, j);
    return haversineKm(lat, lon, goalLat, goalLon);
  };

  const N = rows * cols;
  const gScore = new Float64Array(N).fill(Infinity);
  gScore[startId] = 0;
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const open = new Heap();
  open.push(h(si, sj), startId);
  let found = startId === goalId;

  while (open.size()) {
    const cur = open.pop()[1];
    if (cur === goalId) {
      found = true;
      break;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = (cur / cols) | 0;
    const cj = cur % cols;
    const [clat, clon] = grid.cellCenter(ci, cj);
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB[k][0];
      const nj = cj + NB[k][1];
      if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
      const nid = ni * cols + nj;
      if (closed[nid]) continue;
      const [nlat, nlon] = grid.cellCenter(ni, nj);
      const step = haversineKm(clat, clon, nlat, nlon);
      const tentative = gScore[cur] + step * hazardMultiplier(layer[nid]);
      if (tentative < gScore[nid]) {
        came[nid] = cur;
        gScore[nid] = tentative;
        open.push(tentative + h(ni, nj), nid);
      }
    }
  }

  if (!found) return [start.slice() as LatLon, goal.slice() as LatLon];
  return reconstruct(grid, came, goalId, start, goal);
}

/** True if the straight segment between two cells crosses no storm cell. */
function lineOfSight(
  grid: HazardGrid,
  i0: number,
  j0: number,
  i1: number,
  j1: number,
): boolean {
  const { cols, layer } = grid;
  const di = i1 - i0;
  const dj = j1 - j0;
  const n = Math.max(Math.abs(di), Math.abs(dj));
  if (n === 0) return layer[i0 * cols + j0] < HAZARD_DBZ;
  const steps = 2 * n;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const ii = Math.floor(i0 + di * t + 0.5);
    const jj = Math.floor(j0 + dj * t + 0.5);
    if (layer[ii * cols + jj] >= HAZARD_DBZ) return false;
  }
  return true;
}

/**
 * Theta* / any-angle A* — mirrors the search embedded in routes_wx_plot.py.
 * Like A*, but links a neighbor straight back to the current cell's parent
 * whenever there's clear line of sight, yielding long straight legs instead of
 * grid-edge zig-zags.
 */
export function thetaStar(
  start: LatLon,
  goal: LatLon,
  grid: HazardGrid,
): LatLon[] {
  const { rows, cols, layer } = grid;
  const [si, sj] = grid.latlonToCell(start[0], start[1]);
  const [gi, gj] = grid.latlonToCell(goal[0], goal[1]);
  const startId = si * cols + sj;
  const goalId = gi * cols + gj;
  const [goalLat, goalLon] = grid.cellCenter(gi, gj);
  const h = (i: number, j: number): number => {
    const [lat, lon] = grid.cellCenter(i, j);
    return haversineKm(lat, lon, goalLat, goalLon);
  };
  const dist = (ai: number, aj: number, bi: number, bj: number): number => {
    const a = grid.cellCenter(ai, aj);
    const b = grid.cellCenter(bi, bj);
    return haversineKm(a[0], a[1], b[0], b[1]);
  };

  const N = rows * cols;
  const gScore = new Float64Array(N).fill(Infinity);
  gScore[startId] = 0;
  const parent = new Int32Array(N).fill(-1);
  parent[startId] = startId;
  const closed = new Uint8Array(N);
  const open = new Heap();
  open.push(h(si, sj), startId);
  let found = startId === goalId;

  while (open.size()) {
    const cur = open.pop()[1];
    if (cur === goalId) {
      found = true;
      break;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;
    const ci = (cur / cols) | 0;
    const cj = cur % cols;
    const par = parent[cur];
    const pi = (par / cols) | 0;
    const pj = par % cols;
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB[k][0];
      const nj = cj + NB[k][1];
      if (ni < 0 || ni >= rows || nj < 0 || nj >= cols) continue;
      const nid = ni * cols + nj;
      if (closed[nid]) continue;
      let candPar: number;
      let candG: number;
      if (lineOfSight(grid, pi, pj, ni, nj)) {
        // path 2: direct from parent
        candPar = par;
        candG = gScore[par] + dist(pi, pj, ni, nj);
      } else {
        // path 1: ordinary step
        candPar = cur;
        candG = gScore[cur] + dist(ci, cj, ni, nj) * hazardMultiplier(layer[nid]);
      }
      if (candG < gScore[nid]) {
        parent[nid] = candPar;
        gScore[nid] = candG;
        open.push(candG + h(ni, nj), nid);
      }
    }
  }

  if (!found) return [start.slice() as LatLon, goal.slice() as LatLon];
  // Theta* uses parent pointers, with the start as its own parent.
  const cells = [goalId];
  while (parent[cells[cells.length - 1]] !== cells[cells.length - 1])
    cells.push(parent[cells[cells.length - 1]]);
  cells.reverse();
  return cellsToPath(grid, cells, start, goal);
}

function reconstruct(
  grid: HazardGrid,
  came: Int32Array,
  goalId: number,
  start: LatLon,
  goal: LatLon,
): LatLon[] {
  const cells = [goalId];
  while (came[cells[cells.length - 1]] !== -1)
    cells.push(came[cells[cells.length - 1]]);
  cells.reverse();
  return cellsToPath(grid, cells, start, goal);
}

function cellsToPath(
  grid: HazardGrid,
  cells: number[],
  start: LatLon,
  goal: LatLon,
): LatLon[] {
  const { cols } = grid;
  const path: LatLon[] = [start.slice() as LatLon];
  for (const c of cells) path.push(grid.cellCenter((c / cols) | 0, c % cols));
  path.push(goal.slice() as LatLon);
  return path;
}

// name -> algorithm. Theta* is listed first so the smoother route is default.
export const REROUTERS: Record<string, RouteFn> = {
  thetastar: thetaStar,
  astar: aStar,
};
export const ALGO_LABELS: Record<string, string> = {
  thetastar: "Theta* (smooth)",
  astar: "A* (grid)",
};

export function getRouter(name = "thetastar"): RouteFn {
  return REROUTERS[name] ?? REROUTERS.thetastar;
}
