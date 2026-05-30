// API client + shared types for the Airspace Foresight dashboard.

export interface SnapshotInfo {
  snapshot: string;
  n_strips: number;
}

export interface Hotspot {
  name: string;
  band: "HIGH" | "LOW";
  capacity: number;
  peakDemand: number;
  peakRatio: number;
  peakTimeIndex: number;
  peakTime: string;
  overSteps: number;
}

export interface Overview {
  snapshot: string;
  askedAt: string;
  windowStart: string;
  windowEnd: string;
  nSteps: number;
  stepMinutes: number;
  times: string[];
  airborneCount: number[];
  nFlights: number;
  nAirborneAtAsked: number;
  peakAirborne: number;
  nOverDemandSectors: number;
  totalSectors: number;
  hotspots: Hotspot[];
  hasWeather: boolean;
  nWeatherStrips: number;
  stepToStrip: number[];
  nConflicts: number;
  builtMs: number;
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
  hazardMinutes: number;
  maxDbz: number;
  peakLat: number;
  peakLon: number;
  peakTime: string;
}

export interface ConflictsResp {
  snapshot: string;
  hasWeather: boolean;
  nConflicts: number;
  stepMinutes: number;
  conflicts: Conflict[];
}

export interface WeatherDelayRec {
  kind: "WEATHER_DELAY";
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  beforeHazardMin: number;
  delayMin: number | null;
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
  excess: number;
  contributors: number;
  groundHoldable: number;
  action: string;
}
export interface RecommendationsResp {
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

export interface RerouteResp {
  found: boolean;
  id: string;
  flightNumber: string;
  origin: string;
  dest: string;
  altFt: number;
  cleared: boolean;
  side: number;
  offsetNm: number;
  addedNm: number;
  addedMin: number;
  original: { lats: number[]; lons: number[] };
  reroute: { lats: number[]; lons: number[] };
  message: string;
}

export interface WhatIfResp {
  snapshot: string;
  nSteps: number;
  times: string[];
  delaysApplied: number;
  summary: {
    beforeOver: number;
    afterOver: number;
    relieved: number;
    worsened: number;
    beforePeakExcess: number;
    afterPeakExcess: number;
  };
  sectors: { name: string; band: "HIGH" | "LOW"; capacity: number; demand: number[] }[];
}

// flight position tuple: [lon, lat, band(1=HIGH/0=LOW), inWeather(1/0)]
export type PosTuple = [number, number, number, number];
export interface PositionsResp {
  snapshot: string;
  t: number;
  count: number;
  flights: PosTuple[];
}

// weather cell tuple: [lat, lon, dbz, topFt]
export type WxCell = [number, number, number, number];

export interface WeatherResp {
  snapshot: string;
  hasWeather: boolean;
  stripIndex: number;
  validFrom: string;
  validTo: string;
  minDbz: number;
  cellDeg: { dLat: number; dLon: number };
  count: number;
  cells: WxCell[];
}

export interface SectorGeom {
  name: string;
  band: "HIGH" | "LOW";
  capacity: number;
  altitude_from_ft: number;
  altitude_to_ft: number;
  centroid: [number, number];
  ring: number[][];
}

export interface SectorsResp {
  count: number;
  sectors: SectorGeom[];
}

export interface DemandSeries {
  name: string;
  band: "HIGH" | "LOW";
  capacity: number;
  demand: number[];
}

export interface DemandResp {
  snapshot: string;
  nSteps: number;
  times: string[];
  sectors: DemandSeries[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const api = {
  snapshots: () => getJson<{ snapshots: SnapshotInfo[] }>("api/snapshots"),
  overview: (snapshot: string) =>
    getJson<Overview>(`api/overview?snapshot=${encodeURIComponent(snapshot)}`),
  sectors: () => getJson<SectorsResp>("api/sectors"),
  demand: (snapshot: string) =>
    getJson<DemandResp>(`api/demand?snapshot=${encodeURIComponent(snapshot)}`),
  conflicts: (snapshot: string) =>
    getJson<ConflictsResp>(
      `api/conflicts?snapshot=${encodeURIComponent(snapshot)}`,
    ),
  weather: (snapshot: string, strip: number, minDbz = 15) =>
    getJson<WeatherResp>(
      `api/weather?snapshot=${encodeURIComponent(snapshot)}&strip=${strip}&minDbz=${minDbz}`,
    ),
  recommendations: (snapshot: string) =>
    getJson<RecommendationsResp>(
      `api/recommendations?snapshot=${encodeURIComponent(snapshot)}`,
    ),
  reroute: (snapshot: string, id: string) =>
    getJson<RerouteResp>(
      `api/reroute?snapshot=${encodeURIComponent(snapshot)}&id=${encodeURIComponent(id)}`,
    ),
  whatif: (snapshot: string) =>
    getJson<WhatIfResp>(`api/whatif?snapshot=${encodeURIComponent(snapshot)}`),
  positions: (snapshot: string, t: number) =>
    getJson<PositionsResp>(
      `api/positions?snapshot=${encodeURIComponent(snapshot)}&t=${t}`,
    ),
};
