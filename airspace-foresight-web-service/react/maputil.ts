// Projection + color helpers for the canvas sector map.

import { geoAlbers, GeoProjection } from "d3-geo";

/**
 * Albers conic projection (the standard for US maps — correct proportions and
 * curved parallels) fitted to the supplied polygon rings so CONUS fills the
 * canvas. Returns a d3 projection; call proj([lon, lat]) -> [x, y] | null.
 */
export function makeAlbersFit(
  rings: number[][][],
  w: number,
  h: number,
  pad: number,
): GeoProjection {
  const geo = {
    type: "MultiPolygon",
    coordinates: rings.map((r) => [r]),
  } as any;
  return geoAlbers().fitExtent(
    [
      [pad, pad],
      [w - pad, h - pad],
    ],
    geo,
  );
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
 * Fill color for a demand/capacity ratio over the light "positron" basemap.
 * Empty sectors stay nearly transparent so land/state borders show through;
 * load ramps green -> amber -> orange -> red as it approaches and exceeds
 * capacity (translucent so the basemap remains visible).
 */
export function demandFill(ratio: number): string {
  if (ratio <= 0) return "rgba(120,135,160,0.07)";
  let rgb: number[];
  if (ratio < 0.7) rgb = mix(GREEN, AMBER, ratio / 0.7);
  else if (ratio < 1.0) rgb = mix(AMBER, ORANGE, (ratio - 0.7) / 0.3);
  else if (ratio < 1.4) rgb = mix(ORANGE, RED, (ratio - 1.0) / 0.4);
  else rgb = mix(RED, DEEPRED, Math.min(1, (ratio - 1.4) / 0.6));
  const alpha = ratio >= 1 ? 0.7 : 0.28 + 0.32 * (ratio / 1.0);
  return `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${alpha.toFixed(3)})`;
}

// ---- light "carto-positron"-style basemap palette ----
export const MAP_BG = "#e7edf3"; // water / canvas background
export const LAND_FILL = "#f6f7f9"; // CONUS landmass (slightly lighter than water)
export const STATE_BORDER = "rgba(90,103,122,0.6)"; // state outlines

// Generic stop-table interpolation: stops are [t in 0..1, [r,g,b]].
function colorFromStops(stops: [number, number[]][], t: number): number[] {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  if (x <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (x - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

// Plotly "turbo" colorscale (weather density heatmap, to match the Python map).
const TURBO_STOPS: [number, number[]][] = [
  [0.0, [48, 18, 59]],
  [0.07, [65, 69, 171]],
  [0.13, [57, 118, 233]],
  [0.2, [29, 168, 255]],
  [0.25, [24, 193, 224]],
  [0.33, [38, 212, 167]],
  [0.4, [108, 229, 107]],
  [0.5, [176, 237, 55]],
  [0.58, [225, 225, 29]],
  [0.66, [252, 191, 28]],
  [0.75, [253, 140, 39]],
  [0.83, [238, 86, 38]],
  [0.91, [203, 42, 38]],
  [1.0, [122, 4, 3]],
];

/**
 * Turbo color for a dBZ value over [20, 60] dBZ. We start partway up the ramp
 * (skip turbo's near-black low end) so light precip reads as blue/green on the
 * light basemap rather than as dark smudges — a vivid heatmap like the Python map.
 */
export function turboCss(dbz: number, alpha = 0.7): string {
  const t = (dbz - 20) / 40;
  const c = colorFromStops(TURBO_STOPS, 0.18 + 0.82 * (t < 0 ? 0 : t > 1 ? 1 : t));
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
}

// Viridis colorscale (flight markers by cruise altitude, to match the Python map).
const VIRIDIS_STOPS: [number, number[]][] = [
  [0.0, [68, 1, 84]],
  [0.1, [72, 40, 120]],
  [0.2, [62, 74, 137]],
  [0.3, [49, 104, 142]],
  [0.4, [38, 130, 142]],
  [0.5, [31, 158, 137]],
  [0.6, [53, 183, 121]],
  [0.7, [110, 206, 88]],
  [0.8, [181, 222, 43]],
  [1.0, [253, 231, 37]],
];

/** Viridis color for a cruise altitude, mapped over [0, 45000] ft. */
export function viridisAlt(altFt: number): string {
  const c = colorFromStops(VIRIDIS_STOPS, altFt / 45000);
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
}

// Reflectivity color ramp (NWS-style), keyed by dBZ.
const RADAR_STOPS: [number, number[]][] = [
  [15, [56, 142, 110]], // light - teal/green
  [25, [40, 190, 90]], // green
  [32, [150, 214, 50]], // yellow-green
  [38, [245, 222, 60]], // yellow
  [43, [247, 165, 45]], // orange
  [48, [240, 90, 45]], // red-orange
  [53, [222, 40, 48]], // red
  [58, [206, 50, 130]], // red-magenta
  [63, [224, 80, 235]], // magenta
];

/** Reflectivity color [r,g,b] for a dBZ value (clamped to the ramp). */
export function radarRGB(dbz: number): number[] {
  if (dbz <= RADAR_STOPS[0][0]) return RADAR_STOPS[0][1];
  for (let i = 1; i < RADAR_STOPS.length; i++) {
    if (dbz <= RADAR_STOPS[i][0]) {
      const [d0, c0] = RADAR_STOPS[i - 1];
      const [d1, c1] = RADAR_STOPS[i];
      return mix(c0, c1, (dbz - d0) / (d1 - d0));
    }
  }
  return RADAR_STOPS[RADAR_STOPS.length - 1][1];
}

/** Alpha for a reflectivity blob — lighter precip is fainter. */
export function radarAlpha(dbz: number): number {
  return Math.max(0.18, Math.min(0.8, 0.18 + ((dbz - 15) / 45) * 0.6));
}

export function radarCss(dbz: number, alpha = 0.7): string {
  const c = radarRGB(dbz);
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
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
