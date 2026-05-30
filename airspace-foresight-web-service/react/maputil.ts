// Projection + color helpers for the canvas sector map.

export interface Projection {
  project: (lon: number, lat: number) => [number, number];
  scale: number;
  kx: number; // longitude compression factor cos(meanLat)
}

/**
 * Fit a lon/lat bounding box into a w x h canvas with equirectangular
 * projection (longitude compressed by cos(meanLat) so CONUS isn't stretched).
 */
export function makeProjection(
  bbox: [number, number, number, number],
  w: number,
  h: number,
  pad: number,
): Projection {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const meanLat = (minLat + maxLat) / 2;
  const kx = Math.cos((meanLat * Math.PI) / 180);
  const dataW = (maxLon - minLon) * kx;
  const dataH = maxLat - minLat;
  const sx = (w - 2 * pad) / dataW;
  const sy = (h - 2 * pad) / dataH;
  const scale = Math.min(sx, sy);
  // center
  const offX = (w - dataW * scale) / 2;
  const offY = (h - dataH * scale) / 2;
  return {
    scale,
    kx,
    project: (lon: number, lat: number) => {
      const x = offX + (lon - minLon) * kx * scale;
      const y = offY + (maxLat - lat) * scale; // lat up -> y down
      return [x, y];
    },
  };
}

export function bboxOfRings(rings: number[][][]): [number, number, number, number] {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLon, minLat, maxLon, maxLat];
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function mix(c1: number[], c2: number[], t: number): number[] {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

const GREEN = [34, 197, 94];
const AMBER = [234, 179, 8];
const ORANGE = [249, 115, 22];
const RED = [239, 68, 68];
const DEEPRED = [185, 28, 28];

/**
 * Fill color for a demand/capacity ratio. Empty sectors stay near-transparent
 * slate; load ramps green -> amber -> orange -> red as it approaches and
 * exceeds capacity.
 */
export function demandFill(ratio: number): string {
  if (ratio <= 0) return "rgba(51,65,85,0.28)";
  let rgb: number[];
  if (ratio < 0.7) rgb = mix(GREEN, AMBER, ratio / 0.7);
  else if (ratio < 1.0) rgb = mix(AMBER, ORANGE, (ratio - 0.7) / 0.3);
  else if (ratio < 1.4) rgb = mix(ORANGE, RED, (ratio - 1.0) / 0.4);
  else rgb = mix(RED, DEEPRED, Math.min(1, (ratio - 1.4) / 0.6));
  const alpha = ratio >= 1 ? 0.85 : 0.5 + 0.3 * (ratio / 1.0);
  return `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${alpha.toFixed(3)})`;
}

/** Convective cell color by reflectivity (dBZ): amber -> red -> magenta. */
export function wxColor(dbz: number, alpha = 0.62): string {
  let rgb: number[];
  if (dbz < 50) rgb = mix([250, 204, 21], [239, 68, 68], (dbz - 40) / 10);
  else rgb = mix([239, 68, 68], [217, 70, 239], Math.min(1, (dbz - 50) / 10));
  return `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${alpha})`;
}

export function ratioLabel(ratio: number): string {
  if (ratio <= 0) return "idle";
  if (ratio < 0.7) return "ok";
  if (ratio < 1.0) return "busy";
  return "OVER";
}

// ---- client-side trajectory interpolation (mirrors the backend model) ----

const R_NM = 3440.065;
const DEG = Math.PI / 180;
function haversineNm(a: number, b: number, c: number, d: number): number {
  const dLat = (c - a) * DEG;
  const dLon = (d - b) * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a * DEG) * Math.cos(c * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface PreparedTrack {
  lats: number[];
  lons: number[];
  cum: number[];
  total: number;
  t0: number;
  t1: number;
}

export function prepareTrack(
  lats: number[],
  lons: number[],
  t0: number,
  t1: number,
): PreparedTrack {
  const cum = new Array(lats.length);
  cum[0] = 0;
  for (let i = 1; i < lats.length; i++)
    cum[i] = cum[i - 1] + haversineNm(lats[i - 1], lons[i - 1], lats[i], lons[i]);
  return { lats, lons, cum, total: cum[cum.length - 1], t0, t1 };
}

/** Position [lon, lat] at time tMs, or null if not airborne then. */
export function posOnTrack(tr: PreparedTrack, tMs: number): [number, number] | null {
  if (tMs < tr.t0 || tMs > tr.t1) return null;
  const span = tr.t1 - tr.t0;
  const frac = span > 0 ? (tMs - tr.t0) / span : 0;
  if (tr.total <= 0) return [tr.lons[0], tr.lats[0]];
  const target = frac * tr.total;
  let lo = 0,
    hi = tr.cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tr.cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const segLen = tr.cum[i] - tr.cum[i - 1];
  const f = segLen > 0 ? (target - tr.cum[i - 1]) / segLen : 0;
  return [
    tr.lons[i - 1] + f * (tr.lons[i] - tr.lons[i - 1]),
    tr.lats[i - 1] + f * (tr.lats[i] - tr.lats[i - 1]),
  ];
}

// point in (screen-space) ring
export function pointInScreenRing(
  x: number,
  y: number,
  pts: Float64Array,
): boolean {
  let inside = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2];
    const yi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const yj = pts[j * 2 + 1];
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
