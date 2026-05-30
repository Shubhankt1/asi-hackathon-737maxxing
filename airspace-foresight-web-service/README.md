# airspace-foresight-web-service

The Swizzy full‑stack web service behind **Airspace Foresight** — an integrated
National Airspace System (NAS) risk‑forecast dashboard. It serves a React +
Tailwind frontend and a TypeScript analysis engine (4D trajectories, sector
demand, weather hazards, mitigations) from one Express app, using the
`@swizzyweb/swizzy-web-service` framework.

> Project overview, data formats, and the offline weather‑prep step live in the
> repo root [`../README.md`](../README.md).

## Quick start

```bash
# weather/data must be staged first (from the repo root):
#   python3 ../prep/prep_wx.py asked_at_2025-05-29T21:00:00Z   # one snapshot
#   python3 ../prep/prep_wx.py                                  # all snapshots

npm install
npm run build      # webpack frontend -> bundle/  +  tsc backend -> dist/
npm run server     # serve via swerve on http://localhost:3005
# or: npm run dev   (build + server)
```

Open http://localhost:3005.

## Layout

```
src/                              backend (tsc -> dist/, ESM, NodeNext)
  engine/                         framework-agnostic analysis core
    types.ts        domain types
    geo.ts          haversine + ray-casting point-in-polygon
    trajectory.ts   FlightTrack: position at time t / fraction along route
    sectors.ts      GeoJSON load + uniform-grid spatial index (point -> sector)
    weather.ts      packed-grid loader, time->strip, sample(lat,lon), hazard test
    store.ts        per-snapshot demand analysis + weather-conflict detection (cached)
    recommend.ts    departure-delay search + sector-metering analysis (cached)
    reroute.ts      lateral deviation geometry around a storm cell
    whatif.ts       demand recomputed with recommended delays applied
  routers/
    PageRouter/     serves the static frontend bundle (bundle/)
    ApiRouter/      JSON API; one WebController per endpoint
  web-service.ts    top-level WebService (router registration)
  app.ts            getWebservice() entry used by swerve

react/                            frontend (webpack + Babel -> bundle/)
  App.tsx           dashboard shell: map + scrubber + sidebar tabs
  SectorMap.tsx     dependency-free <canvas> map (sectors, weather, flights)
  SectorTimeline.tsx  per-sector demand-vs-capacity SVG chart
  maputil.ts        projection, color ramps, client-side trajectory interpolation
  api.ts            typed API client

data/                  staged inputs/derived assets (gitignored; created by prep_wx.py)
```

`tsconfig.json` excludes `react/` (Babel transpiles it via webpack, not tsc).

## API

All under `/api`. Most accept `?snapshot=<asked_at_dir>` (defaults to the first
staged snapshot).

| Endpoint | Returns |
|---|---|
| `GET /api/snapshots` | staged snapshots |
| `GET /api/overview` | KPIs, horizon times, step→weather‑strip map, top hotspots |
| `GET /api/sectors[?band=HIGH\|LOW]` | static sector geometry + capacity |
| `GET /api/demand` | per‑sector demand time series |
| `GET /api/weather?strip=<i>` (or `&t=<step>`) | convective hazard cells for a strip |
| `GET /api/conflicts` | flights penetrating weather (+ routes, hazard intervals) |
| `GET /api/recommendations` | ranked delay + metering mitigations w/ before/after |
| `GET /api/reroute?id=<conflict id>` | lateral deviation path + added NM/min |
| `GET /api/whatif` | demand recomputed with recommended delays + before/after diff |

Frontend deep‑link params: `?band=`, `?t=<step>`,
`?tab=hotspots|weather|actions`, `?sector=<name>`, `?flight=<index>`, `?rr=1`,
`?whatif=1`.

## Adding an endpoint (Swizzy)

Use the swizzy MCP / CLI to scaffold, then implement the body:

```bash
# create a controller registered under the Api router
swizzy create_controller --name FooController --action foo --router Api --method get
```

This adds `src/routers/ApiRouter/controllers/foo-controller.ts` and registers it
in `api-router.ts`. Implement `getInitializedController` to call into `engine/`
and `res.json(...)`. The engine modules own all data loading/caching, so
controllers stay thin.

## Config

Launched by `swerve` via `web-service-config.local.json` (port `3005`,
`servicePath: "."`). `serviceArgs` there are passed to `getWebservice()` in
`src/app.ts`.

## Notes

- No external map tiles or tokens — the canvas renders the CONUS sector mosaic
  directly, so it works offline.
- The only non‑Node dependency is the one‑time `prep/prep_wx.py` (NumPy) that
  unpacks the weather `.npz` grids into the packed binaries this service reads.
