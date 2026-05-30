// Lateral reroute geometry: for a weather-conflicted flight, bulge the
// hazardous portion of its path sideways until it samples clear of convective
// hazard. A geometric heuristic (not an optimal solver), but it produces a
// realistic deviation with quantified extra distance/time for the viz.

import { getAnalysis, getWeather } from "./store.js";
import { FlightTrack } from "./trajectory.js";
import { WeatherCube } from "./weather.js";

const STEP_MS = 5 * 60 * 1000;
const NM_PER_DEG = 60;

interface Pt {
  lat: number;
  lon: number;
  t: number;
}

export interface RerouteResult {
  found: boolean;
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  cleared: boolean;
  side: number; // +1 / -1
  offsetNm: number;
  addedNm: number;
  addedMin: number;
  original: { lats: number[]; lons: number[] };
  reroute: { lats: number[]; lons: number[] };
  message: string;
}

function haversineNm(a: number, b: number, c: number, d: number): number {
  const R = 3440.065;
  const DEG = Math.PI / 180;
  const dLat = (c - a) * DEG;
  const dLon = (d - b) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a * DEG) * Math.cos(c * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathLenNm(lats: number[], lons: number[]): number {
  let s = 0;
  for (let i = 1; i < lats.length; i++)
    s += haversineNm(lats[i - 1], lons[i - 1], lats[i], lons[i]);
  return s;
}

function densify(tr: FlightTrack): Pt[] {
  const span = tr.t1 - tr.t0;
  const pts: Pt[] = [];
  // ensure at least a handful of points even for short legs
  const step = Math.min(STEP_MS, Math.max(60000, span / 40));
  for (let t = tr.t0; t <= tr.t1; t += step) {
    const frac = span > 0 ? (t - tr.t0) / span : 0;
    const p = tr.positionAtFrac(frac);
    pts.push({ lat: p.lat, lon: p.lon, t });
  }
  return pts;
}

function hazardAt(cube: WeatherCube, pt: Pt, altFt: number): boolean {
  const smp = cube.sample(cube.stripForTime(pt.t), pt.lat, pt.lon);
  return !!smp && smp.refc >= 40 && smp.retop >= altFt;
}

export function getReroute(snapshot: string, id: string): RerouteResult | null {
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

  const base = (msg: string, extra: Partial<RerouteResult> = {}): RerouteResult => ({
    found: true,
    id,
    flightNumber: f.flight_number,
    origin: f.origin_airport_icao,
    dest: f.destination_airport_icao,
    altFt: tr.altFt,
    cleared: false,
    side: 0,
    offsetNm: 0,
    addedNm: 0,
    addedMin: 0,
    original: { lats: [], lons: [] },
    reroute: { lats: [], lons: [] },
    message: msg,
    ...extra,
  });

  const pts = densify(tr);
  const origLats = pts.map((p) => p.lat);
  const origLons = pts.map((p) => p.lon);
  const original = { lats: origLats, lons: origLons };

  // hazardous indices
  const haz = pts.map((p) => hazardAt(cube, p, tr.altFt));
  let a0 = haz.indexOf(true);
  if (a0 < 0) return base("No hazard found along route", { original });
  let b0 = haz.lastIndexOf(true);
  // pad the span a little so the deviation starts/ends in the clear
  a0 = Math.max(1, a0 - 2);
  b0 = Math.min(pts.length - 2, b0 + 2);

  // chord anchors (kept fixed); perpendicular direction in local E/N
  const A = pts[a0 - 1];
  const B = pts[b0 + 1];
  const midLat = (A.lat + B.lat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180) || 1;
  const east = (B.lon - A.lon) * cosLat;
  const north = B.lat - A.lat;
  const clen = Math.hypot(east, north) || 1;
  // unit perpendicular (E, N)
  const pE = -north / clen;
  const pN = east / clen;

  const speed = f.cruise_speed_kt || 450;
  const origLenNm = pathLenNm(origLats, origLons);

  for (let offset = 20; offset <= 200; offset += 20) {
    for (const side of [1, -1]) {
      const lats = origLats.slice();
      const lons = origLons.slice();
      for (let k = a0; k <= b0; k++) {
        // triangular/sine bump: 0 at ends, max at middle
        const w = Math.sin((Math.PI * (k - a0 + 0.5)) / (b0 - a0 + 1));
        const dNm = side * offset * w;
        const dNorthNm = pN * dNm;
        const dEastNm = pE * dNm;
        lats[k] = pts[k].lat + dNorthNm / NM_PER_DEG;
        lons[k] =
          pts[k].lon + dEastNm / (NM_PER_DEG * Math.max(0.2, Math.cos((pts[k].lat * Math.PI) / 180)));
      }
      // re-check hazard along the deviated path at the same times
      let clear = true;
      for (let k = a0; k <= b0; k++) {
        if (hazardAt(cube, { lat: lats[k], lon: lons[k], t: pts[k].t }, tr.altFt)) {
          clear = false;
          break;
        }
      }
      if (clear) {
        const newLen = pathLenNm(lats, lons);
        const addedNm = Math.max(0, newLen - origLenNm);
        return base("Lateral deviation clears the cell", {
          cleared: true,
          side,
          offsetNm: offset,
          addedNm: Math.round(addedNm),
          addedMin: Math.round((addedNm / speed) * 60),
          original,
          reroute: { lats, lons },
        });
      }
    }
  }
  return base("No lateral deviation within 200 NM clears it — consider altitude change / delay", {
    original,
  });
}
