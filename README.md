# Airspace Foresight

An integrated **National Airspace System (NAS) risk forecast** dashboard for the
ASI aviation hackathon. From a single point-in-time data snapshot it looks ~18
hours ahead and answers three questions that together drive Traffic Flow
Management, then recommends what to do about them:

1. **Where will ATC sectors exceed capacity, and when?** (demand‑capacity balancing)
2. **Which flights will fly into convective weather?** (`≥40 dBZ` with storm tops
   at/above the flight's cruise altitude)
3. **What mitigations help?** Minimal departure delays that clear weather
   conflicts (using the *time‑evolving* forecast) and sector metering to bring
   over‑demand back to capacity — each with before/after numbers.

It's built as a single **Swizzy full‑stack web service** (React + Tailwind
frontend served by the PageRouter; a TypeScript analysis engine behind ApiRouter
controllers). The entire 4D‑trajectory / sector / weather engine runs natively
in TypeScript — the only offline step is a tiny NumPy script that unpacks the
weather `.npz` grids into Node‑readable binaries.

## What it uses from the data bundle

| Data | Used for |
|---|---|
| `routes.json` (per snapshot) | 16,687 flights → reconstruct 4D trajectories (position at any time, constant cruise speed/altitude along waypoints) |
| `wx/refc` + `wx/retop` (73 × 15‑min strips) | convective hazard: composite reflectivity + echo‑top altitude |
| `sectors.geojson` (712 sectors, 2 bands) | point‑in‑polygon sector assignment + per‑sector capacity |

## Architecture

```
prep/prep_wx.py (one-time, NumPy)
   npz refc/retop  ->  data/snapshots/<snap>/wx/{refc_i8.bin, retop_u16.bin, manifest.json}
   routes.json, sectors.geojson  ->  copied into data/

airspace-foresight-web-service/  (Swizzy)
  src/engine/
    trajectory.ts   position of a flight at time t (cumulative gc-distance ÷ time)
    geo.ts          haversine + ray-casting point-in-polygon
    sectors.ts      GeoJSON load + uniform-grid spatial index (point -> sector)
    weather.ts      packed-grid loader, time->strip, sample(lat,lon), hazard test
    store.ts        per-snapshot demand analysis + weather-conflict detection (cached)
    recommend.ts    departure-delay search + sector-metering analysis (cached)
  src/routers/ApiRouter/controllers/
    snapshots, overview, sectors, demand, weather, conflicts, recommendations
  react/
    App.tsx, SectorMap.tsx (canvas map), api.ts, maputil.ts
```

The map is a dependency‑free HTML canvas (no tile server / token, works offline):
the sector mosaic itself draws the shape of CONUS, colored green→red by
demand÷capacity, with a convective‑weather overlay and animated conflict flights.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/snapshots` | available snapshots |
| `GET /api/overview?snapshot=` | KPIs, horizon times, step→weather‑strip map, top hotspots |
| `GET /api/sectors[?band=]` | static sector geometry + capacity |
| `GET /api/demand?snapshot=` | per‑sector demand time series |
| `GET /api/weather?snapshot=&strip=` | convective hazard cells for a forecast strip |
| `GET /api/conflicts?snapshot=` | flights penetrating weather (+ routes, hazard intervals) |
| `GET /api/recommendations?snapshot=` | ranked delay + metering mitigations w/ before/after |
| `GET /api/reroute?snapshot=&id=` | lateral deviation path around the storm for one flight (+ added NM/min) |
| `GET /api/whatif?snapshot=` | sector demand recomputed with recommended delays applied + before/after diff |

## Running it

```bash
# 1) one-time: unpack the weather grids + stage data for a snapshot
python3 prep/prep_wx.py asked_at_2025-05-29T21:00:00Z
#    (omit the arg to process all snapshots)

# 2) build + run the Swizzy service
cd airspace-foresight-web-service
npm install
npm run build          # webpack frontend + tsc backend
npm run server         # serves on http://localhost:3005
```

Open http://localhost:3005. Deep‑link params: `?band=HIGH|LOW`, `?t=<step>`,
`?tab=hotspots|weather|actions`, `?flight=<conflict index>`, `?sector=<name>`,
`?rr=1` (auto‑reroute the deep‑linked flight), `?whatif=1` (apply mitigations).

### Interactions
- **Time scrubber / play** animates the 18 h forecast; KPIs update live.
- **Click a sector** (map or hotspot list) → demand‑vs‑capacity timeline chart.
- **Weather tab** → click a conflict to fly its route; **Reroute around weather**
  draws the lateral deviation and its cost.
- **△ what‑if delays** recolors the map with demand *after* the recommended
  weather delays, with a before/after diff banner (the ripple into sectors).

## Headline result (snapshot 2025‑05‑29 21:00Z)

- 16,687 flights, 3,606 airborne at snapshot time
- **35 sectors** exceed capacity over the horizon; **238 excess sector‑flights**,
  135 of them still on the ground (meterable)
- **373 flights** penetrate convective hazard — and **372 of them clear with a
  departure delay** (median **30 min**); only **1** needs a lateral reroute
- per‑snapshot analysis computes in ~250 ms (cached)

## Modelling notes / assumptions

- Constant cruise speed & altitude along the filed waypoints (per dataset docs);
  elapsed‑time fraction is mapped onto cumulative path distance so takeoff and
  landing times are honored exactly.
- Hazard = `refc ≥ 40 dBZ` **and** `retop ≥ cruise_altitude_ft` at the flight's
  position, sampled from the forecast strip valid at that clock time.
- Demand is sampled on a 5‑minute grid; sector membership is exact
  point‑in‑polygon by altitude band.
- The delay search exploits that the forecast evolves over the horizon: a later
  departure can let a cell move on / decay. Searched in 15‑min steps up to 4 h.
