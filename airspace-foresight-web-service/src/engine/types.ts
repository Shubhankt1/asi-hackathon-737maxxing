// Shared domain types for the Airspace Foresight engine.

export interface Flight {
  flight_number: string;
  take_off_time: string;
  scheduled_landing_time: string;
  origin_airport_icao: string;
  destination_airport_icao: string;
  cruise_altitude_ft: number;
  cruise_speed_kt: number;
  lats: number[];
  lons: number[];
  is_airborne: boolean;
}

export interface RoutesFile {
  asked_at: string;
  window_start: string;
  window_end: string;
  flights: Flight[];
}

export interface SectorFeatureProps {
  name: string;
  altitude_from_ft: number;
  altitude_to_ft: number;
  capacity: number;
}

export type Band = "HIGH" | "LOW";

export interface SectorRecord {
  name: string;
  band: Band;
  altitude_from_ft: number;
  altitude_to_ft: number;
  capacity: number;
  ring: number[][]; // outer ring, [lon, lat] pairs
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  centroid: [number, number]; // lon, lat
}
