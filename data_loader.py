"""
data_loader.py — shared foundation for loading routes, sectors, and weather.

Usage:
    from data_loader import load_routes, load_sectors, load_weather, SCENARIOS

    routes  = load_routes("asked_at_2025-07-14T22:35:00Z")
    sectors = load_sectors()
    weather = load_weather("asked_at_2025-07-14T22:35:00Z")  # refc + retop strips
"""

import gzip
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import numpy as np
from shapely.geometry import shape, Polygon

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

BUNDLE = Path(__file__).parent / "hackathon_data_bundle"
SECTORS_FILE = BUNDLE / "sectors.geojson"

SCENARIOS = sorted(
    [d.name for d in BUNDLE.iterdir() if d.is_dir() and d.name.startswith("asked_at_")]
)

# ---------------------------------------------------------------------------
# Weather grid constants (from FILE_FORMAT.md)
# ---------------------------------------------------------------------------

LAT_MIN, LAT_MAX = 21.943, 55.7765
LON_MIN, LON_MAX = -135.0, -67.5
ROWS, COLS = 256, 358

REFC_HAZARD_THRESHOLD = 40.0   # dBZ — anything >= this is hazardous


def latlon_to_pixel(lat: float, lon: float) -> tuple[int, int]:
    """Convert (lat, lon) to nearest (row, col) in the weather grid."""
    row = int((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * ROWS)
    col = int((lon - LON_MIN) / (LON_MAX - LON_MIN) * COLS)
    row = max(0, min(ROWS - 1, row))
    col = max(0, min(COLS - 1, col))
    return row, col


def pixel_to_latlon(i: int, j: int) -> tuple[float, float]:
    """Top-left corner of pixel [i, j] → (lat, lon)."""
    lat = LAT_MAX - i / ROWS * (LAT_MAX - LAT_MIN)
    lon = LON_MIN + j / COLS * (LON_MAX - LON_MIN)
    return lat, lon


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Flight:
    flight_number: str
    take_off_time: datetime
    scheduled_landing_time: datetime
    origin_icao: str
    destination_icao: str
    cruise_altitude_ft: float
    cruise_speed_kt: float
    lats: list[float]
    lons: list[float]
    is_airborne: bool

    @property
    def uid(self) -> str:
        return f"{self.flight_number}_{self.origin_icao}_{self.take_off_time.isoformat()}"

    @property
    def duration_s(self) -> float:
        return (self.scheduled_landing_time - self.take_off_time).total_seconds()

    def position_at(self, t: datetime) -> Optional[tuple[float, float]]:
        """
        Interpolate (lat, lon) at time t along the planned route.
        Returns None if t is outside [take_off_time, scheduled_landing_time].
        Assumes constant speed between waypoints.
        """
        if t < self.take_off_time or t > self.scheduled_landing_time:
            return None

        frac = (t - self.take_off_time).total_seconds() / self.duration_s
        frac = max(0.0, min(1.0, frac))

        n = len(self.lats)
        if n == 1:
            return self.lats[0], self.lons[0]

        # Compute cumulative great-circle-ish distances (simple Euclidean OK for CONUS)
        seg_lens = []
        for i in range(n - 1):
            dlat = self.lats[i + 1] - self.lats[i]
            dlon = self.lons[i + 1] - self.lons[i]
            seg_lens.append((dlat**2 + dlon**2) ** 0.5)

        total = sum(seg_lens) or 1.0
        target = frac * total

        cum = 0.0
        for i, seg in enumerate(seg_lens):
            if cum + seg >= target or i == len(seg_lens) - 1:
                t_seg = (target - cum) / seg if seg > 0 else 0.0
                t_seg = max(0.0, min(1.0, t_seg))
                lat = self.lats[i] + t_seg * (self.lats[i + 1] - self.lats[i])
                lon = self.lons[i] + t_seg * (self.lons[i + 1] - self.lons[i])
                return lat, lon
            cum += seg

        return self.lats[-1], self.lons[-1]


@dataclass
class Sector:
    name: str
    altitude_from_ft: float
    altitude_to_ft: float
    capacity: int
    geometry: Polygon

    def contains_flight(self, lat: float, lon: float, altitude_ft: float) -> bool:
        from shapely.geometry import Point
        if not (self.altitude_from_ft <= altitude_ft < self.altitude_to_ft):
            return False
        return self.geometry.contains(Point(lon, lat))


@dataclass
class WeatherStrip:
    """One 15-minute weather slice."""
    based_at: datetime
    valid_from: datetime
    valid_to: datetime
    refc: np.ndarray    # shape (256, 358), dBZ; nodata <= -50
    retop: np.ndarray   # shape (256, 358), feet; nodata < 0

    @property
    def valid_mid(self) -> datetime:
        mid_s = (self.valid_to - self.valid_from).total_seconds() / 2
        return self.valid_from.replace(
            second=int(self.valid_from.second + mid_s)
        )

    def refc_at(self, lat: float, lon: float) -> float:
        """Composite reflectivity (dBZ) at (lat, lon). Returns -999 if nodata."""
        r, c = latlon_to_pixel(lat, lon)
        val = float(self.refc[r, c])
        return val if val > -50 else -999.0

    def retop_at(self, lat: float, lon: float) -> float:
        """Echo-top altitude (ft) at (lat, lon). Returns -999 if nodata."""
        r, c = latlon_to_pixel(lat, lon)
        val = float(self.retop[r, c])
        return val if val >= 0 else -999.0

    def is_hazardous(self, lat: float, lon: float, altitude_ft: float) -> bool:
        """
        True if a flight at (lat, lon, altitude_ft) is flying through dangerous weather.
        Hazardous = refc >= 40 dBZ AND flight altitude <= storm top.
        """
        refc = self.refc_at(lat, lon)
        retop = self.retop_at(lat, lon)
        if refc == -999 or retop == -999:
            return False
        return refc >= REFC_HAZARD_THRESHOLD and altitude_ft <= retop


@dataclass
class ScenarioData:
    scenario_name: str
    asked_at: datetime
    flights: list[Flight]
    sectors: list[Sector]
    weather_strips: list[WeatherStrip] = field(default_factory=list)

    def get_strip_at(self, t: datetime) -> Optional[WeatherStrip]:
        """Return the weather strip whose window contains time t."""
        for strip in self.weather_strips:
            if strip.valid_from <= t <= strip.valid_to:
                return strip
        return None


# ---------------------------------------------------------------------------
# Loaders
# ---------------------------------------------------------------------------

def _parse_utc(s: str) -> datetime:
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def load_routes(scenario: str) -> tuple[datetime, list[Flight]]:
    """
    Load flights for a scenario directory name (e.g. 'asked_at_2025-07-14T22:35:00Z').
    Returns (asked_at, list[Flight]).
    """
    gz_path = BUNDLE / scenario / "routes.json.gz"
    json_path = BUNDLE / scenario / "routes.json"
    if gz_path.exists():
        with gzip.open(gz_path, "rt") as f:
            raw = json.load(f)
    else:
        with open(json_path, "rt") as f:
            raw = json.load(f)

    asked_at = _parse_utc(raw["asked_at"])
    flights = []
    for r in raw["flights"]:
        flights.append(Flight(
            flight_number=r["flight_number"],
            take_off_time=_parse_utc(r["take_off_time"]),
            scheduled_landing_time=_parse_utc(r["scheduled_landing_time"]),
            origin_icao=r["origin_airport_icao"],
            destination_icao=r["destination_airport_icao"],
            cruise_altitude_ft=r["cruise_altitude_ft"],
            cruise_speed_kt=r["cruise_speed_kt"],
            lats=r["lats"],
            lons=r["lons"],
            is_airborne=r["is_airborne"],
        ))
    return asked_at, flights


def load_sectors() -> list[Sector]:
    """Load all sectors from sectors.geojson (or .geojson.gz if present)."""
    gz_path = SECTORS_FILE.with_suffix(".geojson.gz")
    if gz_path.exists():
        with gzip.open(gz_path, "rt") as f:
            raw = json.load(f)
    elif SECTORS_FILE.exists():
        with open(SECTORS_FILE, "rt") as f:
            raw = json.load(f)
    else:
        raise FileNotFoundError(f"Sectors file not found at {SECTORS_FILE} or .gz")

    sectors = []
    for feat in raw["features"]:
        p = feat["properties"]
        sectors.append(Sector(
            name=p["name"],
            altitude_from_ft=p["altitude_from_ft"],
            altitude_to_ft=p["altitude_to_ft"],
            capacity=p["capacity"],
            geometry=shape(feat["geometry"]),
        ))
    return sectors


def _parse_wx_filename(stem: str) -> tuple[datetime, datetime, datetime]:
    """Parse 'YYYY-MM-DD_HH:MM:SS_YYYY-MM-DD_HH:MM:SS_YYYY-MM-DD_HH:MM:SS' → 3 datetimes."""
    parts = stem.split("_")
    # Each datetime is date_time = 2 parts joined by '_'
    def parse_pair(date_str, time_str):
        return datetime.fromisoformat(f"{date_str}T{time_str}").replace(tzinfo=timezone.utc)

    based_at  = parse_pair(parts[0], parts[1])
    valid_from = parse_pair(parts[2], parts[3])
    valid_to   = parse_pair(parts[4], parts[5])
    return based_at, valid_from, valid_to


def load_weather(scenario: str, kind: str = "both") -> list[WeatherStrip]:
    """
    Load weather strips for a scenario.
    kind: 'refc', 'retop', or 'both' (default).
    Returns list[WeatherStrip] sorted by valid_from.
    Strips are keyed by (based_at, valid_from, valid_to); refc and retop are merged.
    """
    wx_dir = BUNDLE / scenario / "wx"
    strips: dict[tuple, dict] = {}

    for wx_kind in (["refc", "retop"] if kind == "both" else [kind]):
        kind_dir = wx_dir / wx_kind
        if not kind_dir.exists():
            continue
        for npz_file in kind_dir.glob("*.npz"):
            stem = npz_file.stem
            try:
                based_at, valid_from, valid_to = _parse_wx_filename(stem)
            except Exception:
                continue

            key = (based_at, valid_from, valid_to)
            if key not in strips:
                strips[key] = {"based_at": based_at, "valid_from": valid_from, "valid_to": valid_to}

            matrix = np.load(npz_file)["matrix"]
            strips[key][wx_kind] = matrix

    result = []
    empty = np.full((ROWS, COLS), -999.0)
    for key, d in strips.items():
        result.append(WeatherStrip(
            based_at=d["based_at"],
            valid_from=d["valid_from"],
            valid_to=d["valid_to"],
            refc=d.get("refc", empty),
            retop=d.get("retop", empty),
        ))

    return sorted(result, key=lambda s: s.valid_from)


def load_scenario(scenario: str, load_wx: bool = True) -> ScenarioData:
    """Convenience: load everything for a scenario in one call."""
    asked_at, flights = load_routes(scenario)
    sectors = load_sectors()
    wx = load_weather(scenario) if load_wx else []
    return ScenarioData(
        scenario_name=scenario,
        asked_at=asked_at,
        flights=flights,
        sectors=sectors,
        weather_strips=wx,
    )


# ---------------------------------------------------------------------------
# Quick sanity check
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    scenario = SCENARIOS[4]   # 2025-07-14 — summer, likely stormy
    print(f"Loading scenario: {scenario}")

    data = load_scenario(scenario)

    print(f"  asked_at  : {data.asked_at}")
    print(f"  flights   : {len(data.flights)}")
    print(f"  sectors   : {len(data.sectors)}")
    print(f"  wx strips : {len(data.weather_strips)}")

    # Sample flight
    f = data.flights[0]
    print(f"\nSample flight: {f.flight_number} {f.origin_icao} → {f.destination_icao}")
    print(f"  altitude  : {f.cruise_altitude_ft} ft")
    print(f"  waypoints : {len(f.lats)}")
    mid = f.position_at(f.take_off_time + (f.scheduled_landing_time - f.take_off_time) / 2)
    print(f"  midpoint  : {mid}")

    # Sample weather
    strip = data.weather_strips[0]
    print(f"\nFirst wx strip: {strip.valid_from} → {strip.valid_to}")
    print(f"  refc max  : {strip.refc[strip.refc > -50].max():.1f} dBZ")
    print(f"  retop max : {strip.retop[strip.retop >= 0].max():.0f} ft")

    # Sample sector
    s = data.sectors[0]
    print(f"\nFirst sector: {s.name}, capacity={s.capacity}, alt=[{s.altitude_from_ft}, {s.altitude_to_ft})")
