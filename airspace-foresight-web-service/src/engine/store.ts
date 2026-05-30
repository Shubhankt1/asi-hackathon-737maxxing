// Snapshot store: loads routes + sectors, runs the demand-capacity analysis
// over the forecast horizon, and caches results per snapshot.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Band, Flight, RoutesFile, SectorRecord } from "./types.js";
import { FlightTrack } from "./trajectory.js";
import { SectorIndex, bandForAltitude, buildSectorRecords } from "./sectors.js";
import { WeatherCube } from "./weather.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/engine -> project root -> data
export const DATA_DIR = path.resolve(__dirname, "../../data");

const STEP_MS = 5 * 60 * 1000; // 5-minute demand steps
const HORIZON_MS = 18 * 60 * 60 * 1000; // 18 hours forward

// ---- shared sectors (snapshot-independent) ----
let _sectorIndex: SectorIndex | null = null;
export function getSectorIndex(): SectorIndex {
  if (!_sectorIndex) {
    const gj = JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, "sectors.geojson"), "utf8"),
    );
    _sectorIndex = new SectorIndex(buildSectorRecords(gj));
  }
  return _sectorIndex;
}

// ---- per-snapshot weather (lazy) ----
const _wxCache = new Map<string, WeatherCube | null>();
export function getWeather(snapshot: string): WeatherCube | null {
  if (_wxCache.has(snapshot)) return _wxCache.get(snapshot)!;
  const cube = WeatherCube.loadFromDir(path.join(snapshotDir(snapshot), "wx"));
  _wxCache.set(snapshot, cube);
  return cube;
}

export interface HazardInterval {
  startIndex: number;
  endIndex: number;
  startTime: string;
  endTime: string;
}

export interface Conflict {
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  t0: number;
  t1: number;
  lats: number[];
  lons: number[];
  intervals: HazardInterval[];
  hazardSteps: number;
  maxDbz: number;
  peakLat: number;
  peakLon: number;
  peakTime: string;
}

export interface Hotspot {
  name: string;
  band: Band;
  capacity: number;
  peakDemand: number;
  peakRatio: number;
  peakTimeIndex: number;
  peakTime: string;
  overSteps: number; // # of time steps above capacity
}

export interface SnapshotAnalysis {
  snapshot: string;
  askedAt: number;
  windowStart: string;
  windowEnd: string;
  times: number[]; // epoch ms per step
  nFlights: number;
  nAirborneAtAsked: number;
  airborneCount: number[]; // total airborne per step
  sectorNames: string[];
  capacity: number[];
  band: Band[];
  demand: Int16Array; // flat [sectorIdx * nSteps + ti]
  nSteps: number;
  hotspots: Hotspot[];
  tracks: FlightTrack[]; // kept for downstream (weather, recs)
  hasWeather: boolean;
  nWeatherStrips: number;
  stepToStrip: number[]; // weather strip index per demand step
  conflicts: Conflict[];
  builtMs: number;
}

const _cache = new Map<string, SnapshotAnalysis>();

export function listSnapshots(): { snapshot: string; n_strips: number }[] {
  const idxPath = path.join(DATA_DIR, "snapshots", "index.json");
  if (!fs.existsSync(idxPath)) return [];
  return JSON.parse(fs.readFileSync(idxPath, "utf8")).snapshots ?? [];
}

export function snapshotDir(snapshot: string): string {
  return path.join(DATA_DIR, "snapshots", snapshot);
}

function loadRoutes(snapshot: string): RoutesFile {
  const p = path.join(snapshotDir(snapshot), "routes.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function getAnalysis(snapshot: string): SnapshotAnalysis {
  const cached = _cache.get(snapshot);
  if (cached) return cached;
  const a = buildAnalysis(snapshot);
  _cache.set(snapshot, a);
  return a;
}

/**
 * Positions of every airborne flight at a given demand step, as compact tuples
 * [lon, lat, band(1=HIGH/0=LOW), inWeather(1/0)]. Used by the "all flights"
 * display mode. Cheap: one pass over the cached tracks.
 */
export function getPositionsAtStep(snapshot: string, ti: number): number[][] {
  const a = getAnalysis(snapshot);
  const cube = getWeather(snapshot);
  const tiC = Math.max(0, Math.min(a.nSteps - 1, ti));
  const t = a.times[tiC];
  const out: number[][] = [];
  for (const tr of a.tracks) {
    if (!tr.airborneAt(t)) continue;
    const pos = tr.positionAt(t);
    if (!pos) continue;
    const band = bandForAltitude(tr.altFt);
    let inWx = 0;
    if (cube) {
      const s = cube.sample(cube.stripForTime(t), pos.lat, pos.lon);
      if (s && s.refc >= 40 && s.retop >= tr.altFt) inWx = 1;
    }
    out.push([
      +pos.lon.toFixed(3),
      +pos.lat.toFixed(3),
      band === "HIGH" ? 1 : 0,
      inWx,
    ]);
  }
  return out;
}

function buildAnalysis(snapshot: string): SnapshotAnalysis {
  const t0 = Date.now();
  const routes = loadRoutes(snapshot);
  const askedAt = Date.parse(routes.asked_at);
  const sectors = getSectorIndex();
  const sectorRecords: SectorRecord[] = sectors.sectors;

  const sectorNames = sectorRecords.map((s) => s.name);
  const capacity = sectorRecords.map((s) => s.capacity);
  const band = sectorRecords.map((s) => s.band);
  const nameToIdx = new Map<string, number>();
  sectorNames.forEach((n, i) => nameToIdx.set(n, i));

  // time grid
  const start = askedAt;
  const end = askedAt + HORIZON_MS;
  const times: number[] = [];
  for (let t = start; t <= end; t += STEP_MS) times.push(t);
  const nSteps = times.length;

  // weather (optional)
  const cube = getWeather(snapshot);
  const stepToStrip = new Array<number>(nSteps);
  if (cube) for (let ti = 0; ti < nSteps; ti++) stepToStrip[ti] = cube.stripForTime(times[ti]);
  else stepToStrip.fill(0);

  // flight tracks
  const tracks = routes.flights.map((f: Flight) => new FlightTrack(f));

  const demand = new Int16Array(sectorRecords.length * nSteps);
  const airborneCount = new Array(nSteps).fill(0);
  let nAirborneAtAsked = 0;
  const conflicts: Conflict[] = [];
  const iso = (ms: number) => new Date(ms).toISOString();

  for (const tr of tracks) {
    const altBand = bandForAltitude(tr.altFt);
    if (tr.airborneAt(askedAt)) nAirborneAtAsked++;
    // only iterate the steps this flight is airborne
    let tiStart = Math.ceil((tr.t0 - start) / STEP_MS);
    if (tiStart < 0) tiStart = 0;
    let tiEnd = Math.floor((tr.t1 - start) / STEP_MS);
    if (tiEnd >= nSteps) tiEnd = nSteps - 1;

    // weather-conflict accumulators for this flight
    let curStart = -1,
      curEnd = -1,
      hazardSteps = 0,
      maxDbz = -999,
      peakLat = 0,
      peakLon = 0,
      peakTi = -1;
    const intervals: HazardInterval[] = [];

    for (let ti = tiStart; ti <= tiEnd; ti++) {
      const t = times[ti];
      const pos = tr.positionAt(t);
      if (!pos) continue;
      airborneCount[ti]++;
      if (altBand) {
        const sName = sectors.locate(pos.lat, pos.lon, altBand);
        if (sName != null) demand[nameToIdx.get(sName)! * nSteps + ti]++;
      }
      if (cube) {
        const smp = cube.sample(stepToStrip[ti], pos.lat, pos.lon);
        if (smp && smp.refc >= 40 && smp.retop >= tr.altFt) {
          hazardSteps++;
          if (curStart < 0) curStart = ti;
          curEnd = ti;
          if (smp.refc > maxDbz) {
            maxDbz = smp.refc;
            peakLat = pos.lat;
            peakLon = pos.lon;
            peakTi = ti;
          }
        } else if (curStart >= 0) {
          intervals.push({
            startIndex: curStart,
            endIndex: curEnd,
            startTime: iso(times[curStart]),
            endTime: iso(times[curEnd]),
          });
          curStart = -1;
        }
      }
    }
    if (curStart >= 0)
      intervals.push({
        startIndex: curStart,
        endIndex: curEnd,
        startTime: iso(times[curStart]),
        endTime: iso(times[curEnd]),
      });
    if (intervals.length) {
      const f = tr.flight;
      conflicts.push({
        id: `${f.flight_number}|${f.take_off_time}|${f.origin_airport_icao}`,
        flightNumber: f.flight_number,
        origin: f.origin_airport_icao,
        dest: f.destination_airport_icao,
        altFt: tr.altFt,
        t0: tr.t0,
        t1: tr.t1,
        lats: f.lats,
        lons: f.lons,
        intervals,
        hazardSteps,
        maxDbz,
        peakLat,
        peakLon,
        peakTime: peakTi >= 0 ? iso(times[peakTi]) : "",
      });
    }
  }
  conflicts.sort((a, b) => b.hazardSteps - a.hazardSteps || b.maxDbz - a.maxDbz);

  // hotspots: sectors that exceed capacity at any step
  const hotspots: Hotspot[] = [];
  for (let s = 0; s < sectorRecords.length; s++) {
    let peak = 0;
    let peakTi = 0;
    let over = 0;
    const cap = capacity[s];
    const base = s * nSteps;
    for (let ti = 0; ti < nSteps; ti++) {
      const d = demand[base + ti];
      if (d > peak) {
        peak = d;
        peakTi = ti;
      }
      if (d > cap) over++;
    }
    if (peak > cap) {
      hotspots.push({
        name: sectorNames[s],
        band: band[s],
        capacity: cap,
        peakDemand: peak,
        peakRatio: peak / cap,
        peakTimeIndex: peakTi,
        peakTime: new Date(times[peakTi]).toISOString(),
        overSteps: over,
      });
    }
  }
  hotspots.sort((a, b) => b.peakRatio - a.peakRatio);

  const analysis: SnapshotAnalysis = {
    snapshot,
    askedAt,
    windowStart: routes.window_start,
    windowEnd: routes.window_end,
    times,
    nFlights: routes.flights.length,
    nAirborneAtAsked,
    airborneCount,
    sectorNames,
    capacity,
    band,
    demand,
    nSteps,
    hotspots,
    tracks,
    hasWeather: !!cube,
    nWeatherStrips: cube ? cube.nStrips : 0,
    stepToStrip,
    conflicts,
    builtMs: Date.now() - t0,
  };
  return analysis;
}
