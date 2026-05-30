// Weather cube: loads the packed refc/retop forecast grids for a snapshot and
// answers point samples + hazard-cell queries.
//
// Binary layout (see prep/prep_wx.py):
//   refc_i8.bin   int8   dBZ, nodata -128  -> [strip*ROWS*COLS + row*COLS + col]
//   retop_u16.bin uint16 feet (little-endian), nodata 0
// Host is little-endian (x86), so Uint16Array reads match the file directly.

import fs from "node:fs";
import path from "node:path";

export const ROWS = 256;
export const COLS = 358;
export const LAT_MIN = 21.943;
export const LAT_MAX = 55.7765;
export const LON_MIN = -135.0;
export const LON_MAX = -67.5;
export const HAZARD_DBZ = 40; // < 40 dBZ is "fine" per the dataset docs

interface StripMeta {
  index: number;
  based_at: string | null;
  valid_from: string;
  valid_to: string;
}
interface Manifest {
  snapshot: string;
  n_strips: number;
  strips: StripMeta[];
}

export interface WxSample {
  refc: number; // dBZ (nodata -> -128)
  retop: number; // feet (nodata/no-echo -> 0)
}

function alignedBytes(buf: Buffer): Uint8Array {
  // copy into a fresh, 0-offset buffer so typed-array views are aligned
  const u8 = new Uint8Array(buf.byteLength);
  u8.set(buf);
  return u8;
}

export class WeatherCube {
  readonly manifest: Manifest;
  readonly nStrips: number;
  readonly stripFrom: number[]; // epoch ms
  readonly stripTo: number[];
  private readonly refc: Int8Array;
  private readonly retop: Uint16Array;

  private constructor(manifest: Manifest, refc: Int8Array, retop: Uint16Array) {
    this.manifest = manifest;
    this.nStrips = manifest.n_strips;
    this.refc = refc;
    this.retop = retop;
    this.stripFrom = manifest.strips.map((s) => Date.parse(s.valid_from));
    this.stripTo = manifest.strips.map((s) => Date.parse(s.valid_to));
  }

  static loadFromDir(wxDir: string): WeatherCube | null {
    const manPath = path.join(wxDir, "manifest.json");
    if (!fs.existsSync(manPath)) return null;
    const manifest: Manifest = JSON.parse(fs.readFileSync(manPath, "utf8"));
    const refcBuf = fs.readFileSync(path.join(wxDir, "refc_i8.bin"));
    const retopBuf = fs.readFileSync(path.join(wxDir, "retop_u16.bin"));
    const refc = new Int8Array(alignedBytes(refcBuf).buffer);
    const retop = new Uint16Array(alignedBytes(retopBuf).buffer);
    return new WeatherCube(manifest, refc, retop);
  }

  /** Index of the strip whose [valid_from, valid_to) covers tMs (clamped). */
  stripForTime(tMs: number): number {
    if (tMs <= this.stripFrom[0]) return 0;
    if (tMs >= this.stripFrom[this.nStrips - 1]) return this.nStrips - 1;
    // strips are consecutive 15-min windows sorted by valid_from
    let lo = 0,
      hi = this.nStrips - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.stripFrom[mid] <= tMs) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  cellOf(lat: number, lon: number): { row: number; col: number } | null {
    if (lat < LAT_MIN || lat > LAT_MAX || lon < LON_MIN || lon > LON_MAX)
      return null;
    let row = Math.floor(((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * ROWS);
    let col = Math.floor(((lon - LON_MIN) / (LON_MAX - LON_MIN)) * COLS);
    if (row < 0) row = 0;
    else if (row >= ROWS) row = ROWS - 1;
    if (col < 0) col = 0;
    else if (col >= COLS) col = COLS - 1;
    return { row, col };
  }

  latlonOfCell(row: number, col: number): [number, number] {
    // center of the cell
    const lat = LAT_MAX - ((row + 0.5) / ROWS) * (LAT_MAX - LAT_MIN);
    const lon = LON_MIN + ((col + 0.5) / COLS) * (LON_MAX - LON_MIN);
    return [lat, lon];
  }

  sample(stripIdx: number, lat: number, lon: number): WxSample | null {
    const c = this.cellOf(lat, lon);
    if (!c) return null;
    const base = stripIdx * ROWS * COLS + c.row * COLS + c.col;
    return { refc: this.refc[base], retop: this.retop[base] };
  }

  /** Is a flight at altFt hazarded at (lat,lon) in this strip? */
  isHazard(stripIdx: number, lat: number, lon: number, altFt: number): WxSample | null {
    const s = this.sample(stripIdx, lat, lon);
    if (!s) return null;
    if (s.refc >= HAZARD_DBZ && s.retop >= altFt) return s;
    return null;
  }

  /** All cells in a strip at or above minDbz, as map-ready points. */
  hazardCells(
    stripIdx: number,
    minDbz = HAZARD_DBZ,
  ): { lat: number; lon: number; dbz: number; top: number }[] {
    const out: { lat: number; lon: number; dbz: number; top: number }[] = [];
    const base = stripIdx * ROWS * COLS;
    for (let r = 0; r < ROWS; r++) {
      const rowBase = base + r * COLS;
      for (let c = 0; c < COLS; c++) {
        const d = this.refc[rowBase + c];
        if (d >= minDbz) {
          const [lat, lon] = this.latlonOfCell(r, c);
          out.push({ lat, lon, dbz: d, top: this.retop[rowBase + c] });
        }
      }
    }
    return out;
  }

  cellSizeDeg(): { dLat: number; dLon: number } {
    return {
      dLat: (LAT_MAX - LAT_MIN) / ROWS,
      dLon: (LON_MAX - LON_MIN) / COLS,
    };
  }
}
