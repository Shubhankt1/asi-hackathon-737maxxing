// 4D trajectory model: where is a flight at time t?
//
// Modelling assumption (from the dataset docs): constant cruise altitude and
// constant ground speed along the planned waypoint path, with take_off_time at
// the origin waypoint and scheduled_landing_time at the destination. We map
// elapsed-time fraction onto cumulative path distance so both endpoints are
// honoured exactly and motion is monotonic.

import { Flight } from "./types.js";
import { haversineNm } from "./geo.js";

export interface LatLon {
  lat: number;
  lon: number;
}

export class FlightTrack {
  readonly flight: Flight;
  readonly t0: number; // takeoff epoch ms
  readonly t1: number; // landing epoch ms
  readonly altFt: number;
  private readonly cum: number[]; // cumulative nm at each waypoint
  private readonly total: number; // total path length nm
  private readonly lats: number[];
  private readonly lons: number[];

  constructor(f: Flight) {
    this.flight = f;
    this.t0 = Date.parse(f.take_off_time);
    this.t1 = Date.parse(f.scheduled_landing_time);
    this.altFt = f.cruise_altitude_ft;
    this.lats = f.lats;
    this.lons = f.lons;
    const n = f.lats.length;
    this.cum = new Array(n);
    this.cum[0] = 0;
    for (let i = 1; i < n; i++) {
      this.cum[i] =
        this.cum[i - 1] +
        haversineNm(f.lats[i - 1], f.lons[i - 1], f.lats[i], f.lons[i]);
    }
    this.total = this.cum[n - 1];
  }

  /** Is the aircraft between takeoff and landing at time tMs (inclusive)? */
  airborneAt(tMs: number): boolean {
    return tMs >= this.t0 && tMs <= this.t1;
  }

  /** Position at time tMs, or null if not airborne then. */
  positionAt(tMs: number): LatLon | null {
    if (tMs < this.t0 || tMs > this.t1) return null;
    const span = this.t1 - this.t0;
    return this.positionAtFrac(span > 0 ? (tMs - this.t0) / span : 0);
  }

  /** Position at a fraction [0,1] of the way along the route. */
  positionAtFrac(frac: number): LatLon {
    if (this.total <= 0) return { lat: this.lats[0], lon: this.lons[0] };
    const f0 = frac < 0 ? 0 : frac > 1 ? 1 : frac;
    const targetDist = f0 * this.total;
    const cum = this.cum;
    let lo = 0,
      hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < targetDist) lo = mid + 1;
      else hi = mid;
    }
    const i = Math.max(1, lo); // segment [i-1, i]
    const segLen = cum[i] - cum[i - 1];
    const f = segLen > 0 ? (targetDist - cum[i - 1]) / segLen : 0;
    return {
      lat: this.lats[i - 1] + f * (this.lats[i] - this.lats[i - 1]),
      lon: this.lons[i - 1] + f * (this.lons[i] - this.lons[i - 1]),
    };
  }
}
