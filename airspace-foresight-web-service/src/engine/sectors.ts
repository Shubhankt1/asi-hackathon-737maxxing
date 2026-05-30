// Sector geometry + spatial index for fast point -> sector lookup.
//
// The 712 sectors partition CONUS into two altitude bands (HIGH >= 35k ft,
// LOW < 35k ft) over an identical footprint. A point query returns the single
// sector in the requested band that contains it. We accelerate the
// point-in-polygon tests with a uniform lat/lon grid bucket index.

import { Band, SectorRecord } from "./types.js";
import { pointInRing, ringBbox, ringCentroid } from "./geo.js";

// CONUS-ish bounds (matches the weather grid coverage box).
const GRID_LON_MIN = -135.0;
const GRID_LON_MAX = -67.5;
const GRID_LAT_MIN = 21.943;
const GRID_LAT_MAX = 55.7765;
const CELL = 0.5; // degrees

function bandFor(name: string): Band {
  return name.startsWith("HIGH") ? "HIGH" : "LOW";
}

export class SectorIndex {
  readonly sectors: SectorRecord[];
  private readonly nCols: number;
  private readonly nRows: number;
  private readonly buckets: number[][]; // cell -> sector indices

  constructor(sectors: SectorRecord[]) {
    this.sectors = sectors;
    this.nCols = Math.ceil((GRID_LON_MAX - GRID_LON_MIN) / CELL);
    this.nRows = Math.ceil((GRID_LAT_MAX - GRID_LAT_MIN) / CELL);
    this.buckets = Array.from(
      { length: this.nCols * this.nRows },
      () => [] as number[],
    );
    sectors.forEach((s, idx) => this.indexSector(idx, s));
  }

  private cellId(col: number, row: number): number {
    return row * this.nCols + col;
  }

  private indexSector(idx: number, s: SectorRecord) {
    const [minLon, minLat, maxLon, maxLat] = s.bbox;
    const c0 = this.colOf(minLon);
    const c1 = this.colOf(maxLon);
    const r0 = this.rowOf(minLat);
    const r1 = this.rowOf(maxLat);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        this.buckets[this.cellId(c, r)].push(idx);
      }
    }
  }

  private colOf(lon: number): number {
    return Math.min(
      this.nCols - 1,
      Math.max(0, Math.floor((lon - GRID_LON_MIN) / CELL)),
    );
  }
  private rowOf(lat: number): number {
    return Math.min(
      this.nRows - 1,
      Math.max(0, Math.floor((lat - GRID_LAT_MIN) / CELL)),
    );
  }

  /**
   * Return the name of the sector in `band` containing (lat, lon), or null.
   * Altitude band is chosen by the caller (from flight cruise altitude).
   */
  locate(lat: number, lon: number, band: Band): string | null {
    if (
      lon < GRID_LON_MIN ||
      lon > GRID_LON_MAX ||
      lat < GRID_LAT_MIN ||
      lat > GRID_LAT_MAX
    )
      return null;
    const cell = this.cellId(this.colOf(lon), this.rowOf(lat));
    const cand = this.buckets[cell];
    for (const idx of cand) {
      const s = this.sectors[idx];
      if (s.band !== band) continue;
      const [minLon, minLat, maxLon, maxLat] = s.bbox;
      if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
      if (pointInRing(lon, lat, s.ring)) return s.name;
    }
    return null;
  }
}

/** Band from a flight's cruise altitude. Returns null if above all bands. */
export function bandForAltitude(altFt: number): Band | null {
  if (altFt >= 35000 && altFt < 60000) return "HIGH";
  if (altFt >= 0 && altFt < 35000) return "LOW";
  return null;
}

export function buildSectorRecords(geojson: any): SectorRecord[] {
  const out: SectorRecord[] = [];
  for (const f of geojson.features) {
    const p = f.properties;
    const ring: number[][] = f.geometry.coordinates[0];
    out.push({
      name: p.name,
      band: bandFor(p.name),
      altitude_from_ft: p.altitude_from_ft,
      altitude_to_ft: p.altitude_to_ft,
      capacity: p.capacity,
      ring,
      bbox: ringBbox(ring),
      centroid: ringCentroid(ring),
    });
  }
  return out;
}
