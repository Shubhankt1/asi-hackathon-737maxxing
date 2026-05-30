// What-if: recompute sector demand after applying the recommended weather
// departure delays, then diff against the baseline. This surfaces the
// *secondary* effect — delaying flights to dodge storms ripples into sector
// loading, relieving some sectors and (possibly) stressing others.

import { getAnalysis, getSectorIndex } from "./store.js";
import { getRecommendations } from "./recommend.js";
import { bandForAltitude } from "./sectors.js";

const STEP_MS = 5 * 60 * 1000;

export interface WhatIfResult {
  snapshot: string;
  nSteps: number;
  times: string[];
  delaysApplied: number;
  summary: {
    beforeOver: number;
    afterOver: number;
    relieved: number; // sectors over before, not over after
    worsened: number; // not over before, over after
    beforePeakExcess: number; // sum of (peak-cap) over all sectors, baseline
    afterPeakExcess: number;
  };
  sectors: {
    name: string;
    band: "HIGH" | "LOW";
    capacity: number;
    demand: number[];
  }[];
}

const _cache = new Map<string, WhatIfResult>();

function trackKey(f: any): string {
  return `${f.flight_number}|${f.take_off_time}|${f.origin_airport_icao}`;
}

export function getWhatIf(snapshot: string): WhatIfResult {
  const cached = _cache.get(snapshot);
  if (cached) return cached;

  const a = getAnalysis(snapshot);
  const recs = getRecommendations(snapshot);
  const sectors = getSectorIndex();
  const nSectors = sectors.sectors.length;
  const nSteps = a.nSteps;
  const start = a.times[0];

  // delay map (ms) from recommendations
  const delayMs = new Map<string, number>();
  for (const w of recs.weather)
    if (w.delayMin != null && w.delayMin > 0)
      delayMs.set(w.id, w.delayMin * 60 * 1000);

  const nameToIdx = new Map<string, number>();
  sectors.sectors.forEach((s, i) => nameToIdx.set(s.name, i));

  const demand = new Int16Array(nSectors * nSteps);
  for (const tr of a.tracks) {
    const altBand = bandForAltitude(tr.altFt);
    if (!altBand) continue;
    const delay = delayMs.get(trackKey(tr.flight)) || 0;
    const span = tr.t1 - tr.t0;
    const nt0 = tr.t0 + delay;
    const nt1 = tr.t1 + delay;
    let tiStart = Math.ceil((nt0 - start) / STEP_MS);
    if (tiStart < 0) tiStart = 0;
    let tiEnd = Math.floor((nt1 - start) / STEP_MS);
    if (tiEnd >= nSteps) tiEnd = nSteps - 1;
    for (let ti = tiStart; ti <= tiEnd; ti++) {
      const t = a.times[ti];
      const frac = span > 0 ? (t - nt0) / span : 0;
      const pos = tr.positionAtFrac(frac);
      const sName = sectors.locate(pos.lat, pos.lon, altBand);
      if (sName != null) demand[nameToIdx.get(sName)! * nSteps + ti]++;
    }
  }

  // diff vs baseline
  const out: WhatIfResult["sectors"] = [];
  let afterOver = 0;
  let afterExcess = 0;
  let relieved = 0;
  let worsened = 0;
  const baselineOver = new Set(a.hotspots.map((h) => h.name));

  for (let s = 0; s < nSectors; s++) {
    const cap = sectors.sectors[s].capacity;
    const base = s * nSteps;
    let peak = 0;
    const arr = new Array(nSteps);
    for (let ti = 0; ti < nSteps; ti++) {
      const d = demand[base + ti];
      arr[ti] = d;
      if (d > peak) peak = d;
    }
    const isOver = peak > cap;
    if (isOver) {
      afterOver++;
      afterExcess += peak - cap;
    }
    const wasOver = baselineOver.has(sectors.sectors[s].name);
    if (wasOver && !isOver) relieved++;
    if (!wasOver && isOver) worsened++;
    if (peak > 0)
      out.push({
        name: sectors.sectors[s].name,
        band: sectors.sectors[s].band,
        capacity: cap,
        demand: arr,
      });
  }

  const beforeExcess = a.hotspots.reduce(
    (acc, h) => acc + (h.peakDemand - h.capacity),
    0,
  );

  const result: WhatIfResult = {
    snapshot,
    nSteps,
    times: a.times.map((t) => new Date(t).toISOString()),
    delaysApplied: delayMs.size,
    summary: {
      beforeOver: a.hotspots.length,
      afterOver,
      relieved,
      worsened,
      beforePeakExcess: beforeExcess,
      afterPeakExcess: afterExcess,
    },
    sectors: out,
  };
  _cache.set(snapshot, result);
  return result;
}
