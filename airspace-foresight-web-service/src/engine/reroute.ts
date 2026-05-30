// Weather-aware reroute: an A*/Theta* search around convective weather, a
// server-side port of the reference router in airspace-foresight-py
// (rerouting.AStarRouter + the any-angle Theta* in routes_wx_plot.py). For a
// selected flight it routes from the aircraft's position at the current time to
// its destination, avoiding cells of composite reflectivity >= 40 dBZ, and
// reports the extra distance/time vs. the planned remaining leg.

import { getAnalysis, getWeather } from "./store.js";
import { getHazardGrid, HAZARD_DBZ } from "./hazardGrid.js";
import { haversineNm } from "./geo.js";
import { ALGO_LABELS, getRouter, LatLon } from "./router.js";

export interface RerouteResult {
  found: boolean;
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  algorithm: string;
  waypoints: number;
  cleared: boolean;
  side: number; // retained for response-shape compatibility (unused by A*/Theta*)
  offsetNm: number; // retained for response-shape compatibility
  addedNm: number;
  addedMin: number;
  original: { lats: number[]; lons: number[] };
  reroute: { lats: number[]; lons: number[] };
  message: string;
}

function pathLenNm(lats: number[], lons: number[]): number {
  let s = 0;
  for (let i = 1; i < lats.length; i++)
    s += haversineNm(lats[i - 1], lons[i - 1], lats[i], lons[i]);
  return s;
}

/** Remaining planned leg from `start` to the destination, following the flight's
 *  waypoints past the current along-route fraction (used as the added-distance
 *  baseline). */
function remainingLeg(
  lats: number[],
  lons: number[],
  start: LatLon,
  fracDist: number,
): { lats: number[]; lons: number[] } {
  const n = lats.length;
  // cumulative great-circle distance at each waypoint
  let total = 0;
  const cum = new Array<number>(n);
  cum[0] = 0;
  for (let i = 1; i < n; i++) {
    total += haversineNm(lats[i - 1], lons[i - 1], lats[i], lons[i]);
    cum[i] = total;
  }
  const target = Math.max(0, Math.min(1, fracDist)) * total;
  const outLats = [start[0]];
  const outLons = [start[1]];
  for (let i = 0; i < n; i++) {
    if (cum[i] > target + 1e-6) {
      outLats.push(lats[i]);
      outLons.push(lons[i]);
    }
  }
  // ensure the destination is the final point
  if (outLats[outLats.length - 1] !== lats[n - 1]) {
    outLats.push(lats[n - 1]);
    outLons.push(lons[n - 1]);
  }
  return { lats: outLats, lons: outLons };
}

export function getReroute(
  snapshot: string,
  id: string,
  algo = "thetastar",
  tMs = 0,
): RerouteResult | null {
  const a = getAnalysis(snapshot);
  const cube = getWeather(snapshot);
  if (!cube) return null;
  const tr = a.tracks.find(
    (t) =>
      `${t.flight.flight_number}|${t.flight.take_off_time}|${t.flight.origin_airport_icao}` ===
      id,
  );
  if (!tr) return null;
  const f = tr.flight;
  const n = f.lats.length;
  if (n < 2) return null;

  // start = aircraft position at tMs (origin if not airborne then); goal = dest
  let start: LatLon;
  let fracDist: number;
  const t = tMs || tr.t0;
  if (tr.airborneAt(t)) {
    const p = tr.positionAt(t)!;
    start = [p.lat, p.lon];
    const span = tr.t1 - tr.t0;
    fracDist = span > 0 ? (t - tr.t0) / span : 0;
  } else {
    start = [f.lats[0], f.lons[0]];
    fracDist = 0;
  }
  const goal: LatLon = [f.lats[n - 1], f.lons[n - 1]];

  const grid = getHazardGrid(snapshot, cube.stripForTime(t));
  if (!grid) return null;

  const path = getRouter(algo)(start, goal, grid);
  const lats = path.map((p) => p[0]);
  const lons = path.map((p) => p[1]);

  const original = remainingLeg(f.lats, f.lons, start, fracDist);
  const origLenNm = pathLenNm(original.lats, original.lons);
  const newLenNm = pathLenNm(lats, lons);
  const addedNm = Math.max(0, newLenNm - origLenNm);
  const speed = f.cruise_speed_kt || 450;

  // cleared = no routed waypoint lands in a >= 40 dBZ coarse cell
  let cleared = true;
  for (const [plat, plon] of path) {
    const [ci, cj] = grid.latlonToCell(plat, plon);
    if (grid.dbzAt(ci, cj) >= HAZARD_DBZ) {
      cleared = false;
      break;
    }
  }

  const label = ALGO_LABELS[algo] ?? algo;
  const message = cleared
    ? `${label} routes clear of the weather`
    : `Weather boxes in ${f.flight_number} — straight-line fallback; consider altitude change / delay`;

  return {
    found: true,
    id,
    flightNumber: f.flight_number,
    origin: f.origin_airport_icao,
    dest: f.destination_airport_icao,
    altFt: tr.altFt,
    algorithm: algo,
    waypoints: path.length,
    cleared,
    side: 0,
    offsetNm: 0,
    addedNm: Math.round(addedNm),
    addedMin: Math.round((addedNm / speed) * 60),
    original,
    reroute: { lats, lons },
    message,
  };
}
