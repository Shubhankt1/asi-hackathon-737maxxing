// Recommendation engine: turns the demand + weather analysis into ranked,
// quantified mitigations.
//
//  - WEATHER_DELAY: the forecast evolves over ~18h, so a later departure can
//    let a storm move on / decay. For each weather-conflicted flight we search
//    for the smallest departure delay that makes its whole trajectory clear of
//    convective hazard (>=40 dBZ at/above its altitude). If none within the
//    search window, it's flagged as needing a lateral reroute instead.
//  - SECTOR_METER: for each over-demand sector we count, at its peak minute,
//    how many contributing flights are still on the ground (deferrable) and how
//    many must be metered to bring demand down to capacity.

import { getAnalysis, getSectorIndex, getWeather, SnapshotAnalysis } from "./store.js";
import { FlightTrack } from "./trajectory.js";
import { WeatherCube } from "./weather.js";
import { bandForAltitude } from "./sectors.js";

const STEP_MS = 5 * 60 * 1000;
const DELAY_STEP_MIN = 15;
const MAX_DELAY_MIN = 240;

export interface WeatherDelayRec {
  kind: "WEATHER_DELAY";
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  beforeHazardMin: number;
  delayMin: number | null; // null -> not clearable within window (reroute)
  afterHazardMin: number;
  action: string;
}

export interface SectorMeterRec {
  kind: "SECTOR_METER";
  sector: string;
  band: "HIGH" | "LOW";
  capacity: number;
  peakDemand: number;
  peakTime: string;
  excess: number; // peakDemand - capacity
  contributors: number; // flights in sector at peak
  groundHoldable: number; // contributors still pre-departure
  action: string;
}

export type Recommendation = WeatherDelayRec | SectorMeterRec;

export interface RecommendationsResult {
  snapshot: string;
  summary: {
    nConflicts: number;
    clearableByDelay: number;
    medianDelayMin: number;
    needReroute: number;
    nOverDemandSectors: number;
    totalExcessFlights: number;
    excessGroundHoldable: number;
  };
  weather: WeatherDelayRec[];
  sectors: SectorMeterRec[];
}

const _cache = new Map<string, RecommendationsResult>();

function trackKey(f: any): string {
  return `${f.flight_number}|${f.take_off_time}|${f.origin_airport_icao}`;
}

/** hazard step count for a flight if it departed delayMs later. */
function hazardStepsWithDelay(
  tr: FlightTrack,
  cube: WeatherCube,
  delayMs: number,
): number {
  const nt0 = tr.t0 + delayMs;
  const nt1 = tr.t1 + delayMs;
  const span = tr.t1 - tr.t0;
  let count = 0;
  for (let t = nt0; t <= nt1; t += STEP_MS) {
    const frac = span > 0 ? (t - nt0) / span : 0;
    const pos = tr.positionAtFrac(frac);
    const strip = cube.stripForTime(t);
    const smp = cube.sample(strip, pos.lat, pos.lon);
    if (smp && smp.refc >= 40 && smp.retop >= tr.altFt) count++;
  }
  return count;
}

/** smallest delay (minutes) that clears the conflict, or null if none found. */
function minClearingDelay(tr: FlightTrack, cube: WeatherCube): number | null {
  for (let d = DELAY_STEP_MIN; d <= MAX_DELAY_MIN; d += DELAY_STEP_MIN) {
    if (hazardStepsWithDelay(tr, cube, d * 60 * 1000) === 0) return d;
  }
  return null;
}

export function getRecommendations(snapshot: string): RecommendationsResult {
  const cached = _cache.get(snapshot);
  if (cached) return cached;

  const a: SnapshotAnalysis = getAnalysis(snapshot);
  const cube = getWeather(snapshot);
  const sectors = getSectorIndex();

  // id -> track
  const trackById = new Map<string, FlightTrack>();
  for (const tr of a.tracks) trackById.set(trackKey(tr.flight), tr);

  // ---- weather delay recs ----
  const weather: WeatherDelayRec[] = [];
  const delays: number[] = [];
  let clearable = 0;
  let needReroute = 0;
  if (cube) {
    for (const c of a.conflicts) {
      const tr = trackById.get(c.id);
      if (!tr) continue;
      const d = minClearingDelay(tr, cube);
      if (d == null) {
        needReroute++;
      } else {
        clearable++;
        delays.push(d);
      }
      weather.push({
        kind: "WEATHER_DELAY",
        id: c.id,
        flightNumber: c.flightNumber,
        origin: c.origin,
        dest: c.dest,
        altFt: c.altFt,
        beforeHazardMin: c.hazardSteps * 5,
        delayMin: d,
        afterHazardMin: 0,
        action:
          d == null
            ? `No clearing within ${MAX_DELAY_MIN} min — reroute laterally around the cell`
            : `Delay departure ${d} min to let the cell pass`,
      });
    }
  }
  delays.sort((x, y) => x - y);
  const medianDelay = delays.length
    ? delays[Math.floor(delays.length / 2)]
    : 0;

  // ---- sector metering recs ----
  const sectorRecs: SectorMeterRec[] = [];
  let totalExcess = 0;
  let excessHoldable = 0;
  for (const h of a.hotspots) {
    const peakT = a.times[h.peakTimeIndex];
    const rec = sectors.sectors.find((s) => s.name === h.name)!;
    // who is in this sector at the peak minute?
    let contributors = 0;
    let holdable = 0;
    for (const tr of a.tracks) {
      if (!tr.airborneAt(peakT)) continue;
      if (bandForAltitude(tr.altFt) !== rec.band) continue;
      const pos = tr.positionAt(peakT);
      if (!pos) continue;
      if (sectors.locate(pos.lat, pos.lon, rec.band) !== h.name) continue;
      contributors++;
      if (tr.t0 > a.askedAt) holdable++; // still on the ground at snapshot
    }
    const excess = h.peakDemand - h.capacity;
    totalExcess += excess;
    excessHoldable += Math.min(excess, holdable);
    sectorRecs.push({
      kind: "SECTOR_METER",
      sector: h.name,
      band: h.band,
      capacity: h.capacity,
      peakDemand: h.peakDemand,
      peakTime: h.peakTime,
      excess,
      contributors,
      groundHoldable: holdable,
      action: `Meter ${excess} of ${contributors} flights at ${h.peakTime.slice(11, 16)}Z (${holdable} still on the ground) to reach capacity ${h.capacity}`,
    });
  }

  // rank weather recs: clearable-small-delay first, then reroute, by hazard time
  weather.sort((x, y) => {
    const dx = x.delayMin ?? 9999;
    const dy = y.delayMin ?? 9999;
    return dx - dy || y.beforeHazardMin - x.beforeHazardMin;
  });

  const result: RecommendationsResult = {
    snapshot,
    summary: {
      nConflicts: a.conflicts.length,
      clearableByDelay: clearable,
      medianDelayMin: medianDelay,
      needReroute,
      nOverDemandSectors: a.hotspots.length,
      totalExcessFlights: totalExcess,
      excessGroundHoldable: excessHoldable,
    },
    weather,
    sectors: sectorRecs,
  };
  _cache.set(snapshot, result);
  return result;
}
