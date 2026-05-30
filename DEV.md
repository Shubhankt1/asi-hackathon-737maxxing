# Developer Guide — data_loader.py

Everything you need to load and work with the data. Import from `data_loader` — don't read raw files yourself.

---

## Setup

```bash
source .venv/bin/activate
python data_loader.py   # sanity check: should print 14712 flights, 712 sectors, 73 wx strips
```

**We are demoing with scenario `asked_at_2025-07-14T22:35:00Z`** (index 4 in `SCENARIOS`) — summer, most weather activity.

---

## Loading Data

```python
from data_loader import load_scenario, SCENARIOS

data = load_scenario("asked_at_2025-07-14T22:35:00Z")
# data.flights        → list[Flight]
# data.sectors        → list[Sector]
# data.weather_strips → list[WeatherStrip], sorted by valid_from

# Skip weather if you don't need it (much faster)
data = load_scenario("asked_at_2025-07-14T22:35:00Z", load_wx=False)
```

---

## The Three Data Types

### Flight

One entry per scheduled flight in the snapshot window.

```python
f = data.flights[0]

f.uid                     # unique key — use this as a dict key
f.flight_number           # "SKW6242"
f.origin_icao             # "KPHX"
f.destination_icao        # "KBOI"
f.cruise_altitude_ft      # 11100.0  (constant — no climb/descent modelled)
f.cruise_speed_kt         # 280.0
f.lats, f.lons            # parallel waypoint arrays, origin → destination
f.take_off_time           # datetime, UTC, timezone-aware
f.scheduled_landing_time  # datetime, UTC, timezone-aware
f.is_airborne             # True if already flying at asked_at

# Interpolate position at any moment in time
pos = f.position_at(t)    # → (lat, lon) or None if t is outside flight window
```

### Sector

712 polygons partitioning CONUS airspace. Shared across all scenarios.

```python
s = data.sectors[0]

s.name              # "HIGH_006" or "LOW_006"
s.altitude_from_ft  # 35000  (HIGH band: 35k–60k ft, LOW band: 0–35k ft)
s.altitude_to_ft    # 60000
s.capacity          # max simultaneous flights before sector is over-demand
s.geometry          # shapely Polygon — coordinates are (lon, lat), GeoJSON order

# Check if a flight position falls in this sector (handles altitude band for you)
s.contains_flight(lat=40.0, lon=-90.0, altitude_ft=38000)  # True/False
```

**Warning**: looping over all 712 sectors for every flight × every timestep is slow.
Build a spatial index if you're doing bulk lookups:

```python
from shapely.strtree import STRtree
tree = STRtree([s.geometry for s in data.sectors])
```

### WeatherStrip

One 15-minute slice of radar forecast. ~73 strips per scenario, covering ~18 hours forward.

```python
strip = data.weather_strips[0]

strip.valid_from  # datetime — start of this 15-min window
strip.valid_to    # datetime — end of this 15-min window

# Point lookups — handles nodata masking for you
strip.refc_at(lat, lon)   # dBZ intensity, or -999 if nodata
strip.retop_at(lat, lon)  # storm-top altitude in feet, or -999 if nodata

# Hazard check — the key function
strip.is_hazardous(lat, lon, altitude_ft)
# True when: refc >= 40 dBZ AND flight_altitude <= storm_top
```

Get the strip covering a specific time:

```python
strip = data.get_strip_at(t)  # WeatherStrip or None
```

---

## Hazard Rule

A flight is in dangerous weather when **both** are true:
1. `refc >= 40 dBZ` (heavy precipitation)
2. `flight_altitude_ft <= retop_ft` (flight is below the storm top)

`strip.is_hazardous(lat, lon, altitude_ft)` encodes this exactly.

---

## Coordinate Helpers

The weather data lives on a `(256, 358)` grid. Use these to convert:

```python
from data_loader import latlon_to_pixel, pixel_to_latlon, LAT_MIN, LAT_MAX, LON_MIN, LON_MAX

row, col = latlon_to_pixel(lat=40.0, lon=-90.0)
lat, lon = pixel_to_latlon(row=100, col=200)   # top-left corner of that pixel
```

Grid coverage: lat 21.943–55.777°N, lon -135.0 to -67.5°E. Points outside CONUS have nodata sentinels.

---

## Gotchas

- **All datetimes are UTC and timezone-aware.** Use `datetime(..., tzinfo=timezone.utc)` when constructing times, or comparisons will crash.
- **Shapely uses `(lon, lat)` order** (GeoJSON convention). Don't flip them when calling `Point(lon, lat)`.
- **`position_at(t)` returns `None`** when `t` is before takeoff or after landing. Always check.
- **Nodata sentinels differ**: `refc <= -50` = nodata; `retop < 0` = nodata. The helper methods handle this — avoid indexing the raw arrays directly.

---

## Who Builds What

| File | Owner | Input |
|------|-------|-------|
| `data_loader.py` | shared | raw bundle |
| `analyzer.py` | Person A | `load_scenario()` |
| `rerouter.py` | Person B | analyzer output |
| `advisor.py` | Person C | analyzer output + Claude API |
| `app.py` | Person C | everything |
