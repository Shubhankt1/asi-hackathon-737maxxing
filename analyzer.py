"""
analyzer.py — Person A

Loads a scenario and produces three outputs for the rest of the team:
    hazard_flights    — flights that fly through dangerous weather
    sector_occupancy  — flight counts per sector per timestep
    overdemand_events — sectors that exceed capacity at any point

Quick start:
    from analyzer import run
    results = run()
    results.hazard_flights     # list[HazardHit]
    results.sector_occupancy   # dict[sector_name, dict[datetime, int]]
    results.overdemand_events  # list[OverdemandEvent]

Typical numbers for the demo scenario (asked_at_2025-07-14T22:35:00Z):
    14704 active flights, 73 timesteps (15-min, 18 h forward)
    ~2700 hazard hits across ~2100 flights (HIGH + MEDIUM risk only)
    592 occupied sectors, 28 overdemand events
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np

from shapely.geometry import Point
from shapely.strtree import STRtree

from data_loader import (
    SCENARIOS,
    Flight,
    ScenarioData,
    Sector,
    WeatherStrip,
    load_scenario,
    latlon_to_pixel,
    ROWS,
    COLS,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEMO_SCENARIO = "asked_at_2025-07-14T22:35:00Z"
TIMESTEP_MINUTES = 15


# ---------------------------------------------------------------------------
# Output types (imported by Person B and C)
# ---------------------------------------------------------------------------

NEIGHBORHOOD_RADIUS = 2   # pixels (~28 km) to search around flight position

@dataclass
class HazardHit:
    """A single flight at a single timestep that is in dangerous weather."""
    flight: Flight
    t: datetime
    lat: float
    lon: float
    max_refc_dbz: float       # max reflectivity in neighborhood
    max_retop_ft: float       # max storm top in neighborhood
    altitude_ft: float        # flight cruise altitude
    risk: str                 # "HIGH", "MEDIUM", or "LOW"

    @property
    def vertical_margin_ft(self) -> float:
        """Feet between cruise altitude and nearest storm top. Negative = inside storm."""
        return self.altitude_ft - self.max_retop_ft


@dataclass
class OverdemandEvent:
    """A sector that exceeded capacity at a specific timestep."""
    sector_name: str
    t: datetime
    count: int            # actual flight count in sector
    capacity: int         # sector capacity limit

    @property
    def excess(self) -> int:
        return self.count - self.capacity


@dataclass
class AnalysisResults:
    scenario_name: str
    asked_at: datetime
    time_grid: list[datetime]                              # all timesteps evaluated
    hazard_flights: list[HazardHit]                        # weather hits
    sector_occupancy: dict[str, dict[datetime, int]]       # sector → t → count
    overdemand_events: list[OverdemandEvent]               # over-capacity moments

    @property
    def unique_hazard_flights(self) -> list[Flight]:
        """Deduplicated list of flights that hit hazardous weather at any point."""
        seen = set()
        flights = []
        for h in self.hazard_flights:
            if h.flight.uid not in seen:
                seen.add(h.flight.uid)
                flights.append(h.flight)
        return flights


# ---------------------------------------------------------------------------
# Time grid
# ---------------------------------------------------------------------------

def build_time_grid(asked_at: datetime, hours_forward: int = 18) -> list[datetime]:
    """
    Build a list of UTC datetimes from asked_at to asked_at + hours_forward,
    stepping every TIMESTEP_MINUTES minutes.
    """
    step = timedelta(minutes=TIMESTEP_MINUTES)
    end = asked_at + timedelta(hours=hours_forward)
    grid = []
    t = asked_at
    while t <= end:
        grid.append(t)
        t += step
    return grid


# ---------------------------------------------------------------------------
# Task 2: Flight position interpolation
# ---------------------------------------------------------------------------

def interpolate_positions(
    flights: list[Flight],
    time_grid: list[datetime],
) -> dict[str, list[tuple[datetime, float, float]]]:
    """
    For each flight, compute its (lat, lon) at every timestep in time_grid.

    Returns:
        dict mapping flight.uid → list of (t, lat, lon) tuples.
        Only timesteps where the flight is airborne are included.
        Flights with no active timesteps are omitted.
    """
    positions: dict[str, list[tuple[datetime, float, float]]] = {}

    for flight in flights:
        hits = []
        for t in time_grid:
            pos = flight.position_at(t)
            if pos is not None:
                hits.append((t, pos[0], pos[1]))
        if hits:
            positions[flight.uid] = hits

    return positions


# ---------------------------------------------------------------------------
# Task 3: Weather hazard detection
# ---------------------------------------------------------------------------

def _neighborhood_max(matrix: np.ndarray, row: int, col: int,
                      radius: int, nodata_threshold: float) -> float:
    """
    Return the max valid value in a (2*radius+1)² pixel box around (row, col).
    Pixels where value <= nodata_threshold are excluded.
    Returns -999 if no valid pixels found.
    """
    r0 = max(0, row - radius)
    r1 = min(ROWS - 1, row + radius)
    c0 = max(0, col - radius)
    c1 = min(COLS - 1, col + radius)
    patch = matrix[r0:r1+1, c0:c1+1]
    valid = patch[patch > nodata_threshold]
    return float(valid.max()) if valid.size > 0 else -999.0


def _score_risk(max_refc: float, vertical_margin: float) -> str:
    """
    Assign risk level from max nearby reflectivity and vertical margin.
    vertical_margin = flight_altitude - max_retop  (negative = inside storm)
    """
    if max_refc >= 45 and vertical_margin <= 10000:
        return "HIGH"
    if max_refc >= 40 and vertical_margin <= 5000:
        return "HIGH"
    if max_refc >= 35 and vertical_margin <= 10000:
        return "MEDIUM"
    return "LOW"


def detect_hazards(
    flights: list[Flight],
    positions: dict[str, list[tuple[datetime, float, float]]],
    data: ScenarioData,
    radius: int = NEIGHBORHOOD_RADIUS,
) -> list[HazardHit]:
    """
    For each flight position, scan a pixel neighborhood for hazardous weather
    and assign a risk level (HIGH / MEDIUM / LOW).

    Only returns hits with risk HIGH or MEDIUM (LOW = no meaningful threat).

    Returns list[HazardHit] sorted by (t, risk).
    """
    flight_lookup = {f.uid: f for f in flights}
    hits: list[HazardHit] = []

    for uid, track in positions.items():
        flight = flight_lookup[uid]
        alt = flight.cruise_altitude_ft

        for t, lat, lon in track:
            strip = data.get_strip_at(t)
            if strip is None:
                continue

            row, col = latlon_to_pixel(lat, lon)

            max_refc  = _neighborhood_max(strip.refc,  row, col, radius, nodata_threshold=-50)
            max_retop = _neighborhood_max(strip.retop, row, col, radius, nodata_threshold=0)

            if max_refc == -999 or max_retop == -999:
                continue

            vertical_margin = alt - max_retop
            risk = _score_risk(max_refc, vertical_margin)

            if risk in ("HIGH", "MEDIUM"):
                hits.append(HazardHit(
                    flight=flight,
                    t=t,
                    lat=lat,
                    lon=lon,
                    max_refc_dbz=max_refc,
                    max_retop_ft=max_retop,
                    altitude_ft=alt,
                    risk=risk,
                ))

    hits.sort(key=lambda h: (h.t, h.risk))
    return hits


# ---------------------------------------------------------------------------
# Task 4: Sector occupancy + overdemand detection
# ---------------------------------------------------------------------------

def compute_sector_occupancy(
    sectors: list[Sector],
    positions: dict[str, list[tuple[datetime, float, float]]],
    flight_lookup: dict[str, Flight],
    time_grid: list[datetime],
) -> tuple[dict[str, dict[datetime, int]], list[OverdemandEvent]]:
    """
    For each timestep, count how many flights are in each sector.

    Uses a Shapely STRtree spatial index for fast polygon lookup.

    Returns:
        occupancy       — dict[sector_name, dict[t, count]]
        overdemand      — list[OverdemandEvent] where count > capacity
    """
    # Build spatial index over sector geometries
    # STRtree query returns indices into the sectors list
    tree = STRtree([s.geometry for s in sectors])
    sector_name_to_sector = {s.name: s for s in sectors}

    # Initialize occupancy counters
    occupancy: dict[str, dict[datetime, int]] = {s.name: {} for s in sectors}

    for t in time_grid:
        # Collect all flight positions at this timestep
        for uid, track in positions.items():
            # find position at t — track is sorted by t
            pos = next(((lat, lon) for pt, lat, lon in track if pt == t), None)
            if pos is None:
                continue
            lat, lon = pos
            flight = flight_lookup[uid]
            alt = flight.cruise_altitude_ft

            # Query spatial index — returns candidate sector indices
            pt = Point(lon, lat)  # shapely uses (lon, lat)
            candidate_idxs = tree.query(pt)
            for idx in candidate_idxs:
                s = sectors[idx]
                if s.contains_flight(lat, lon, alt):
                    occupancy[s.name][t] = occupancy[s.name].get(t, 0) + 1
                    break  # a flight belongs to at most one sector per altitude band

    # Build overdemand events
    overdemand: list[OverdemandEvent] = []
    for s in sectors:
        for t, count in occupancy[s.name].items():
            if count > s.capacity:
                overdemand.append(OverdemandEvent(
                    sector_name=s.name,
                    t=t,
                    count=count,
                    capacity=s.capacity,
                ))

    overdemand.sort(key=lambda e: (e.t, e.sector_name))
    return occupancy, overdemand


# ---------------------------------------------------------------------------
# Main analysis entry point
# ---------------------------------------------------------------------------

def run(scenario: str = DEMO_SCENARIO) -> AnalysisResults:
    """
    Load a scenario and run the full analysis pipeline.
    Returns an AnalysisResults object.
    """
    print(f"[analyzer] Loading scenario: {scenario}")
    data = load_scenario(scenario)

    time_grid = build_time_grid(data.asked_at)
    print(f"[analyzer] Time grid: {len(time_grid)} steps "
          f"({time_grid[0]} -> {time_grid[-1]})")
    print(f"[analyzer] Flights: {len(data.flights)}, Sectors: {len(data.sectors)}, "
          f"Wx strips: {len(data.weather_strips)}")

    print("[analyzer] Interpolating flight positions...")
    positions = interpolate_positions(data.flights, time_grid)
    active_flights = [f for f in data.flights if f.uid in positions]
    print(f"[analyzer] Active flights: {len(active_flights)}")

    print("[analyzer] Detecting weather hazards...")
    hazard_hits = detect_hazards(data.flights, positions, data)
    unique_affected = len({h.flight.uid for h in hazard_hits})
    print(f"[analyzer] Hazard hits: {len(hazard_hits)} across {unique_affected} flights")

    print("[analyzer] Computing sector occupancy...")
    flight_lookup = {f.uid: f for f in data.flights}
    occupancy, overdemand = compute_sector_occupancy(
        data.sectors, positions, flight_lookup, time_grid
    )
    occupied_sectors = sum(1 for counts in occupancy.values() if counts)
    print(f"[analyzer] Occupied sectors: {occupied_sectors}, Overdemand events: {len(overdemand)}")

    return AnalysisResults(
        scenario_name=scenario,
        asked_at=data.asked_at,
        time_grid=time_grid,
        hazard_flights=hazard_hits,
        sector_occupancy=occupancy,
        overdemand_events=overdemand,
    )


# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    results = run()
    print(f"\n[analyzer] asked_at        : {results.asked_at}")
    print(f"[analyzer] time_grid       : {len(results.time_grid)} steps")
    print(f"[analyzer] hazard hits     : {len(results.hazard_flights)}")
    print(f"[analyzer] affected flights: {len(results.unique_hazard_flights)}")

    if results.hazard_flights:
        h = results.hazard_flights[0]
        print(f"\nSample hazard:")
        print(f"  flight  : {h.flight.flight_number} ({h.flight.origin_icao} → {h.flight.destination_icao})")
        print(f"  time    : {h.t}")
        print(f"  refc    : {h.max_refc_dbz:.1f} dBZ")
        print(f"  retop   : {h.max_retop_ft:.0f} ft")
        print(f"  altitude: {h.altitude_ft:.0f} ft")
        print(f"  risk    : {h.risk}")
        print(f"  v-margin: {h.vertical_margin_ft:.0f} ft")

    # Sector occupancy sample: pick a sector with the most timesteps occupied
    busiest = max(results.sector_occupancy.items(), key=lambda kv: max(kv[1].values(), default=0))
    sector_name, counts = busiest
    print(f"\nSample sector occupancy ({sector_name}, peak={max(counts.values())} flights):")
    for t, count in sorted(counts.items())[:5]:
        print(f"  {t.strftime('%H:%MZ')}  {'█' * count} {count}")

    if results.overdemand_events:
        e = results.overdemand_events[0]
        print(f"\nSample overdemand:")
        print(f"  sector  : {e.sector_name}")
        print(f"  time    : {e.t}")
        print(f"  count   : {e.count}  (capacity {e.capacity}, excess +{e.excess})")
