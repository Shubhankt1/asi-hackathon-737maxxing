// Coarse weather-hazard cost field for the A*/Theta* reroute search.
//
// A faithful port of rerouting.HazardGrid from airspace-foresight-py: one
// forecast frame's composite reflectivity (dBZ), block-max downsampled by 4
// into a coarse equirectangular grid over the CONUS bounds. Block-*max* is
// deliberately conservative — a coarse cell is as hazardous as the worst pixel
// it covers. The coarse grid keeps the original bounding box, so the same
// lat/lon <-> cell formula as the full-resolution grid applies (just with
// smaller rows/cols).

import { getWeather } from "./store.js";
import {
  COLS,
  HAZARD_DBZ,
  LAT_MAX,
  LAT_MIN,
  LON_MAX,
  LON_MIN,
  ROWS,
} from "./weather.js";

export const DOWNSAMPLE = 4;
export const EARTH_RADIUS_KM = 6371.0088;
// Weather penalty applied to each search step, as a multiplier on distance
// (mirrors rerouting.SOFT_PENALTY / HARD_PENALTY).
export const SOFT_PENALTY = 0.08;
export const HARD_PENALTY = 50.0;
export { HAZARD_DBZ };

export class HazardGrid {
  readonly rows: number;
  readonly cols: number;
  readonly layer: Int16Array; // dBZ per coarse cell, row-major [i*cols + j]

  constructor(layer: Int16Array, rows: number, cols: number) {
    this.layer = layer;
    this.rows = rows;
    this.cols = cols;
  }

  /** Center lat/lon of coarse cell (i, j) — mirrors HazardGrid.cell_center. */
  cellCenter(i: number, j: number): [number, number] {
    const lat = LAT_MAX - ((i + 0.5) / this.rows) * (LAT_MAX - LAT_MIN);
    const lon = LON_MIN + ((j + 0.5) / this.cols) * (LON_MAX - LON_MIN);
    return [lat, lon];
  }

  /** Nearest coarse cell (i, j) for a lat/lon — mirrors HazardGrid.latlon_to_cell. */
  latlonToCell(lat: number, lon: number): [number, number] {
    let i = Math.floor(((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * this.rows);
    let j = Math.floor(((lon - LON_MIN) / (LON_MAX - LON_MIN)) * this.cols);
    if (i < 0) i = 0;
    else if (i >= this.rows) i = this.rows - 1;
    if (j < 0) j = 0;
    else if (j >= this.cols) j = this.cols - 1;
    return [i, j];
  }

  dbzAt(i: number, j: number): number {
    return this.layer[i * this.cols + j];
  }
}

/**
 * Block-max downsample a full-resolution refc strip by `d`, mirroring
 * HazardGrid._block_max_downsample: nodata (<= -50) and negatives -> 0 (clear),
 * cap at 80, pad to a multiple of `d` with 0, then take the max of each d×d
 * block.
 */
function blockMaxDownsample(refc: Int8Array, d: number): HazardGrid {
  const rows = Math.floor((ROWS + (d - 1)) / d); // ceil
  const cols = Math.floor((COLS + (d - 1)) / d); // padded cols, ceil
  const out = new Int16Array(rows * cols); // zero-filled = clear (padding too)
  for (let r = 0; r < ROWS; r++) {
    const I = Math.floor(r / d);
    const rowBase = r * COLS;
    const outRowBase = I * cols;
    for (let c = 0; c < COLS; c++) {
      const v = refc[rowBase + c];
      const x = v < 0 ? 0 : v > 80 ? 80 : v; // nodata(-128)/neg -> 0, cap 80
      const idx = outRowBase + Math.floor(c / d);
      if (x > out[idx]) out[idx] = x;
    }
  }
  return new HazardGrid(out, rows, cols);
}

// Memoized per (snapshot, strip): the search only ever uses one frame at a time.
const _gridCache = new Map<string, HazardGrid>();

export function getHazardGrid(
  snapshot: string,
  stripIdx: number,
): HazardGrid | null {
  const key = `${snapshot}|${stripIdx}`;
  const cached = _gridCache.get(key);
  if (cached) return cached;
  const cube = getWeather(snapshot);
  if (!cube) return null;
  const grid = blockMaxDownsample(cube.refcStrip(stripIdx), DOWNSAMPLE);
  _gridCache.set(key, grid);
  return grid;
}
