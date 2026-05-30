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
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from data_loader import (
    SCENARIOS,
    Flight,
    ScenarioData,
    Sector,
    WeatherStrip,
    load_scenario,
)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEMO_SCENARIO = "asked_at_2025-07-14T22:35:00Z"
TIMESTEP_MINUTES = 15


# ---------------------------------------------------------------------------
# Output types (imported by Person B and C)
# ---------------------------------------------------------------------------

@dataclass
class HazardHit:
    """A single flight at a single timestep that is in dangerous weather."""
    flight: Flight
    t: datetime
    lat: float
    lon: float
    refc_dbz: float       # observed reflectivity at this position
    retop_ft: float       # storm top at this position
    altitude_ft: float    # flight cruise altitude


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
    print(f"[analyzer] Active flights (airborne at some point in grid): {len(active_flights)}")

    return AnalysisResults(
        scenario_name=scenario,
        asked_at=data.asked_at,
        time_grid=time_grid,
        hazard_flights=[],       # filled in by Task 3
        sector_occupancy={},     # filled in by Task 4
        overdemand_events=[],    # filled in by Task 4
    )


# ---------------------------------------------------------------------------
# Sanity check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    results = run()
    print(f"\n[analyzer] asked_at      : {results.asked_at}")
    print(f"[analyzer] time_grid     : {len(results.time_grid)} steps")
    print(f"[analyzer] first step    : {results.time_grid[0]}")
    print(f"[analyzer] last step     : {results.time_grid[-1]}")
