import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  Conflict,
  Overview,
  RecommendationsResp,
  RerouteResp,
  SectorGeom,
  SnapshotInfo,
  WhatIfResp,
  WxCell,
} from "./api";
import { FlightPoint, SectorColorMode, SectorMap } from "./SectorMap";
import { SectorTimeline } from "./SectorTimeline";
import { Logo } from "./Logo";
import { PreparedTrack, posOnTrack, prepareTrack } from "./maputil";

type Band = "HIGH" | "LOW";
type Tab = "hotspots" | "weather" | "actions";
type FlightMode = "conflicts" | "all" | "weather" | "off";

function fmtUTC(iso?: string): string {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}Z`;
}
/** FlightAware live-tracking URL for a flight ident (airline code or tail #). */
function flightAwareUrl(ident: string): string {
  return `https://flightaware.com/live/flight/${encodeURIComponent(ident.trim())}`;
}

function fmtDayUTC(iso?: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const App = () => {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [snapshot, setSnapshot] = useState<string>("");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [sectors, setSectors] = useState<SectorGeom[]>([]);
  const [demandByName, setDemandByName] = useState<Map<string, number[]>>(
    new Map(),
  );
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [recs, setRecs] = useState<RecommendationsResp | null>(null);

  const params =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const [band, setBand] = useState<Band>(
    params.get("band") === "HIGH" ? "HIGH" : "LOW",
  );
  const [timeIndex, setTimeIndex] = useState(
    Math.max(0, Number(params.get("t") || 0)),
  );
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedFlight, setSelectedFlight] = useState<string | null>(null);
  const [reroute, setReroute] = useState<RerouteResp | null>(null);
  const [rerouteLoading, setRerouteLoading] = useState(false);
  const [rerouteAlgo, setRerouteAlgo] = useState<"thetastar" | "astar">(
    "thetastar",
  );
  const [showWeather, setShowWeather] = useState(true);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [sectorColorMode, setSectorColorMode] = useState<SectorColorMode>(
    (["all", "alerts", "off"] as const).includes(params.get("colors") as any)
      ? (params.get("colors") as SectorColorMode)
      : "off",
  );
  const [flightMode, setFlightMode] = useState<FlightMode>(
    (["conflicts", "all", "weather", "off"] as const).includes(
      params.get("flights") as any,
    )
      ? (params.get("flights") as FlightMode)
      : "conflicts",
  );
  const [allPositions, setAllPositions] = useState<number[][] | null>(null);
  const posCache = useRef<Map<number, number[][]>>(new Map());
  const [whatif, setWhatif] = useState<WhatIfResp | null>(null);
  const [whatifOn, setWhatifOn] = useState(params.get("whatif") === "1");
  const [tab, setTab] = useState<Tab>(
    (["hotspots", "weather", "actions"] as const).includes(
      params.get("tab") as any,
    )
      ? (params.get("tab") as Tab)
      : "hotspots",
  );
  const [loading, setLoading] = useState(true);
  const flightParam = useRef<string | null>(params.get("flight"));
  const sectorParam = useRef<string | null>(params.get("sector"));

  // weather strip cache (by strip index)
  const wxCache = useRef<Map<number, { cells: WxCell[]; cellDeg: any }>>(
    new Map(),
  );
  const [wx, setWx] = useState<{ cells: WxCell[]; cellDeg: any } | null>(null);

  useEffect(() => {
    api.snapshots().then((r) => {
      setSnapshots(r.snapshots);
      if (r.snapshots[0]) setSnapshot(r.snapshots[0].snapshot);
    });
    api.sectors().then((r) => setSectors(r.sectors));
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    setLoading(true);
    setSelected(null);
    setSelectedFlight(null);
    wxCache.current.clear();
    setWx(null);
    setRecs(null);
    setWhatif(null);
    posCache.current.clear();
    setAllPositions(null);
    Promise.all([
      api.overview(snapshot),
      api.demand(snapshot),
      api.conflicts(snapshot),
    ]).then(([ov, dem, con]) => {
      setOverview(ov);
      const m = new Map<string, number[]>();
      for (const s of dem.sectors) m.set(s.name, s.demand);
      setDemandByName(m);
      setConflicts(con.conflicts);
      setTimeIndex((ti) => Math.min(Math.max(0, ti), ov.nSteps - 1));
      setLoading(false);
      // optional deep-link to a sector (by name)
      if (sectorParam.current) {
        const name = sectorParam.current;
        sectorParam.current = null;
        setSelected(name);
        setBand(name.startsWith("HIGH") ? "HIGH" : "LOW");
      }
      // optional deep-link to a specific conflict flight (by list index)
      if (flightParam.current != null) {
        const c = con.conflicts[Number(flightParam.current)];
        flightParam.current = null;
        if (c) {
          setSelectedFlight(c.id);
          setShowWeather(true);
          setBand(c.altFt >= 35000 ? "HIGH" : "LOW");
          if (c.intervals[0]) setTimeIndex(c.intervals[0].startIndex);
          if (params.get("rr")) {
            const rrT = c.intervals[0]
              ? Date.parse(ov.times[c.intervals[0].startIndex])
              : c.t0;
            api.reroute(snapshot, c.id, "thetastar", rrT).then(setReroute);
          }
        }
      }
    });
  }, [snapshot]);

  // recommendations load separately (heavier compute, non-blocking)
  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    api.recommendations(snapshot).then((r) => {
      if (!cancelled) setRecs(r);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot]);

  // lazy-load what-if (mitigated demand) the first time it's switched on
  useEffect(() => {
    if (!whatifOn || !snapshot || whatif) return;
    api.whatif(snapshot).then(setWhatif);
  }, [whatifOn, snapshot, whatif]);

  const mitigatedByName = useMemo(() => {
    const m = new Map<string, number[]>();
    if (whatif) for (const s of whatif.sectors) m.set(s.name, s.demand);
    return m;
  }, [whatif]);

  const activeDemand =
    whatifOn && whatif ? mitigatedByName : demandByName;

  const nSteps = overview?.nSteps ?? 0;
  useEffect(() => {
    if (!playing || nSteps === 0) return;
    const id = setInterval(
      () => setTimeIndex((ti) => (ti + 1) % nSteps),
      240,
    );
    return () => clearInterval(id);
  }, [playing, nSteps]);

  // fetch weather for the strip covering the current step
  const stripIdx = overview?.stepToStrip[timeIndex] ?? 0;
  useEffect(() => {
    if (!snapshot || !overview?.hasWeather) return;
    const cached = wxCache.current.get(stripIdx);
    if (cached) {
      setWx(cached);
      return;
    }
    let cancelled = false;
    api.weather(snapshot, stripIdx).then((r) => {
      const v = { cells: r.cells, cellDeg: r.cellDeg };
      wxCache.current.set(stripIdx, v);
      if (!cancelled) setWx(v);
    });
    return () => {
      cancelled = true;
    };
  }, [snapshot, stripIdx, overview?.hasWeather]);

  // all-airborne positions for the current step (fetched + cached) when in
  // "all flights" mode
  useEffect(() => {
    if (flightMode !== "all" || !snapshot) return;
    const cached = posCache.current.get(timeIndex);
    if (cached) {
      setAllPositions(cached);
      return;
    }
    let cancelled = false;
    api.positions(snapshot, timeIndex).then((r) => {
      posCache.current.set(timeIndex, r.flights);
      if (!cancelled) setAllPositions(r.flights);
    });
    return () => {
      cancelled = true;
    };
  }, [flightMode, snapshot, timeIndex]);

  // prepared tracks for conflict flights (for client-side animation)
  const preparedTracks = useMemo(() => {
    const m = new Map<string, PreparedTrack>();
    for (const c of conflicts)
      m.set(c.id, prepareTrack(c.lats, c.lons, c.t0, c.t1));
    return m;
  }, [conflicts]);

  const tMs = overview ? Date.parse(overview.times[timeIndex]) : 0;

  const flightPoints = useMemo<FlightPoint[]>(() => {
    if (flightMode === "off") return [];
    if (flightMode === "all") {
      if (!allPositions) return [];
      return allPositions.map((p, i) => ({
        lon: p[0],
        lat: p[1],
        hazard: p[3] === 1,
        id: "a" + i,
        altFt: p[4],
      }));
    }
    // conflicts / weather modes: animate the weather-conflict flights
    const out: FlightPoint[] = [];
    for (const c of conflicts) {
      const tr = preparedTracks.get(c.id);
      if (!tr) continue;
      const p = posOnTrack(tr, tMs);
      if (!p) continue;
      const hazard = c.intervals.some(
        (iv) => timeIndex >= iv.startIndex && timeIndex <= iv.endIndex,
      );
      if (flightMode === "weather" && !hazard) continue;
      out.push({ lon: p[0], lat: p[1], hazard, id: c.id, altFt: c.altFt });
    }
    return out;
  }, [flightMode, allPositions, conflicts, preparedTracks, tMs, timeIndex]);

  // "in weather now" KPI is mode-independent (derived from conflict intervals)
  const nInHazardNow = useMemo(
    () =>
      conflicts.filter((c) =>
        c.intervals.some(
          (iv) => timeIndex >= iv.startIndex && timeIndex <= iv.endIndex,
        ),
      ).length,
    [conflicts, timeIndex],
  );

  const selFlight = conflicts.find((c) => c.id === selectedFlight) || null;
  const selectedTrack = selFlight
    ? { lats: selFlight.lats, lons: selFlight.lons }
    : null;

  // clear any reroute when the selected flight changes
  useEffect(() => {
    setReroute(null);
  }, [selectedFlight]);

  function requestReroute() {
    if (!selFlight || !snapshot) return;
    setRerouteLoading(true);
    api.reroute(snapshot, selFlight.id, rerouteAlgo, tMs).then((r) => {
      setReroute(r);
      setRerouteLoading(false);
    });
  }

  const overNow = useMemo(() => {
    if (!overview) return 0;
    let n = 0;
    for (const s of sectors) {
      const series = activeDemand.get(s.name);
      if (series && series[timeIndex] > s.capacity) n++;
    }
    return n;
  }, [sectors, activeDemand, timeIndex, overview]);

  const airborneNow = overview?.airborneCount[timeIndex] ?? 0;
  const curTime = overview?.times[timeIndex];
  const bandHotspots = (overview?.hotspots ?? []).filter((h) => h.band === band);

  const selSector = selected ? sectors.find((s) => s.name === selected) : null;
  const selSeries = selected ? activeDemand.get(selected) : undefined;

  function jumpToHotspot(name: string, peakTi: number, b: Band) {
    setBand(b);
    setSelected(name);
    setSelectedFlight(null);
    setTimeIndex(peakTi);
    setPlaying(false);
  }
  function jumpToConflict(c: Conflict) {
    setSelectedFlight(c.id);
    setSelected(null);
    setShowWeather(true);
    setBand(c.altFt >= 35000 ? "HIGH" : "LOW");
    if (c.intervals[0]) setTimeIndex(c.intervals[0].startIndex);
    setPlaying(false);
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-slate-950 font-sans text-slate-200">
      <header className="flex items-center gap-6 border-b border-slate-800 bg-slate-900/80 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <div className="flex flex-col leading-none">
            <span className="text-base font-extrabold tracking-tight">
              <span className="text-sky-400">Airspace</span>{" "}
              <span className="text-slate-100">Foresight</span>
            </span>
            <span className="mt-0.5 hidden text-[10px] text-slate-500 md:inline">
              NAS demand · weather risk forecast
            </span>
          </div>
        </div>
        <select
          className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          value={snapshot}
          onChange={(e) => setSnapshot(e.target.value)}
        >
          {snapshots.map((s) => (
            <option key={s.snapshot} value={s.snapshot}>
              {s.snapshot.replace("asked_at_", "")}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-5 text-xs">
          <Kpi label="flights" value={overview?.nFlights ?? "—"} />
          <Kpi label="airborne now" value={airborneNow} accent="sky" />
          <Kpi
            label="over-demand now"
            value={overNow}
            accent={overNow > 0 ? "red" : "emerald"}
          />
          <Kpi
            label="in weather now"
            value={nInHazardNow}
            accent={nInHazardNow > 0 ? "red" : "emerald"}
          />
          <Kpi
            label="weather conflicts"
            value={overview?.nConflicts ?? "—"}
            accent="amber"
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 bg-slate-950">
          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-slate-400">
              computing demand + weather forecast…
            </div>
          )}
          <SectorMap
            sectors={sectors}
            band={band}
            demandByName={activeDemand}
            timeIndex={timeIndex}
            selected={selected}
            onPick={(n) => {
              setSelected(n);
              setSelectedFlight(null);
            }}
            showWeather={showWeather}
            weatherCells={wx?.cells}
            cellDeg={wx?.cellDeg}
            flightPoints={flightPoints}
            denseFlights={flightMode === "all"}
            selectedTrack={selectedTrack}
            rerouteTrack={reroute?.reroute?.lats?.length ? reroute.reroute : null}
            colorMode={sectorColorMode}
          />
          <div className="absolute left-3 top-3 flex flex-col gap-2">
            <button
              onClick={() => setControlsOpen((o) => !o)}
              className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/85 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-800"
              title={controlsOpen ? "Hide map controls" : "Show map controls"}
            >
              <span>☰ Layers</span>
              <span className="ml-auto text-slate-400">
                {controlsOpen ? "▾" : "▸"}
              </span>
            </button>
            {controlsOpen && (
              <div className="flex flex-col gap-2">
            <div className="flex overflow-hidden rounded-md border border-slate-700 text-xs">
              {(["LOW", "HIGH"] as Band[]).map((b) => (
                <button
                  key={b}
                  onClick={() => setBand(b)}
                  className={`px-3 py-1 ${
                    band === b
                      ? "bg-sky-600 text-white"
                      : "bg-slate-800/80 text-slate-300 hover:bg-slate-700"
                  }`}
                >
                  {b === "LOW" ? "LOW < 35k ft" : "HIGH ≥ 35k ft"}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowWeather((w) => !w)}
              className={`rounded-md border px-3 py-1 text-xs ${
                showWeather
                  ? "border-fuchsia-500 bg-fuchsia-950/50 text-fuchsia-200"
                  : "border-slate-700 bg-slate-800/80 text-slate-400"
              }`}
            >
              {showWeather ? "● weather on" : "○ weather off"}
            </button>
            <button
              onClick={() => setWhatifOn((w) => !w)}
              className={`rounded-md border px-3 py-1 text-xs ${
                whatifOn
                  ? "border-emerald-500 bg-emerald-950/50 text-emerald-200"
                  : "border-slate-700 bg-slate-800/80 text-slate-400"
              }`}
              title="Recolor the map with sector demand after applying recommended weather delays"
            >
              {whatifOn ? "△ what-if: delays applied" : "△ what-if delays"}
            </button>
            <select
              value={flightMode}
              onChange={(e) => setFlightMode(e.target.value as FlightMode)}
              className="rounded-md border border-slate-700 bg-slate-800/90 px-2 py-1 text-xs text-slate-200"
              title="Which flights to plot on the map"
            >
              <option value="conflicts">✈ flights: weather conflicts</option>
              <option value="all">✈ flights: all airborne</option>
              <option value="weather">✈ flights: in weather now</option>
              <option value="off">✈ flights: off</option>
            </select>
            <select
              value={sectorColorMode}
              onChange={(e) =>
                setSectorColorMode(e.target.value as SectorColorMode)
              }
              className="rounded-md border border-slate-700 bg-slate-800/90 px-2 py-1 text-xs text-slate-200"
              title="Which sectors to color by demand"
            >
              <option value="all">▦ sectors: all colors</option>
              <option value="alerts">▦ sectors: high-density / weather</option>
              <option value="off">▦ sectors: no colors</option>
            </select>
            <Legend />
              </div>
            )}
          </div>
          {whatifOn && whatif && (
            <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-md border border-emerald-700 bg-slate-900/95 px-4 py-1.5 text-xs shadow-xl">
              <span className="font-semibold text-emerald-300">
                What-if: {whatif.delaysApplied} weather delays applied
              </span>
              <span className="ml-3 text-slate-300">
                peak excess{" "}
                <span className="font-mono text-slate-400">
                  {whatif.summary.beforePeakExcess}
                </span>{" "}
                →{" "}
                <span className="font-mono font-bold text-emerald-300">
                  {whatif.summary.afterPeakExcess}
                </span>
              </span>
              <span className="ml-3 text-emerald-400">
                ▼ {whatif.summary.relieved} relieved
              </span>
              <span className="ml-2 text-amber-400">
                ▲ {whatif.summary.worsened} new
              </span>
            </div>
          )}

          {selFlight && (
            <div className="absolute bottom-3 left-3 max-w-xs rounded-md border border-sky-700 bg-slate-900/95 px-3 py-2 text-xs shadow-xl">
              <div className="font-semibold text-sky-300">
                {selFlight.flightNumber} · {selFlight.origin}→{selFlight.dest}
              </div>
              <div className="text-slate-300">
                FL{Math.round(selFlight.altFt / 100)} · in weather{" "}
                {selFlight.hazardMinutes} min · max {selFlight.maxDbz} dBZ
              </div>
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={rerouteAlgo}
                  onChange={(e) =>
                    setRerouteAlgo(e.target.value as "thetastar" | "astar")
                  }
                  className="rounded border border-slate-700 bg-slate-800 px-1.5 py-1 text-[11px] text-slate-200"
                  title="Reroute algorithm"
                >
                  <option value="thetastar">Theta* (smooth)</option>
                  <option value="astar">A* (grid)</option>
                </select>
                <button
                  className="rounded border border-emerald-700 bg-emerald-950/50 px-2 py-1 text-[11px] font-medium text-emerald-300 hover:bg-emerald-900/50 disabled:opacity-50"
                  onClick={requestReroute}
                  disabled={rerouteLoading}
                >
                  {rerouteLoading ? "routing…" : "↳ Reroute around weather"}
                </button>
                <a
                  href={flightAwareUrl(selFlight.flightNumber)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded border border-sky-700 bg-sky-950/50 px-2 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-900/50"
                  title={`Track ${selFlight.flightNumber} on FlightAware`}
                >
                  FlightAware ↗
                </a>
                <button
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                  onClick={() => setSelectedFlight(null)}
                >
                  clear ✕
                </button>
              </div>
              {reroute && (
                <div className="mt-2 border-t border-slate-700 pt-1 text-[11px]">
                  {reroute.cleared ? (
                    <span className="text-emerald-300">
                      <span className="font-mono text-emerald-200">
                        +{reroute.addedNm} NM / +{reroute.addedMin} min
                      </span>{" "}
                      {reroute.algorithm === "astar"
                        ? "A* (grid)"
                        : "Theta* (smooth)"}{" "}
                      reroute · {reroute.waypoints} waypoints — green path.
                    </span>
                  ) : (
                    <span className="text-amber-300">{reroute.message}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <aside className="flex w-96 flex-col border-l border-slate-800 bg-slate-900/60">
          <div className="border-b border-slate-800 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              forecast snapshot
            </div>
            <div className="text-sm text-slate-200">
              as of {fmtUTC(overview?.askedAt)} · {fmtDayUTC(overview?.askedAt)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              horizon {fmtUTC(overview?.times[0])} →{" "}
              {fmtUTC(overview?.times[(overview?.nSteps ?? 1) - 1])} ·{" "}
              {overview?.builtMs ?? "?"} ms compute
            </div>
          </div>

          {selSector && (
            <div className="border-b border-slate-800 bg-slate-950/40 px-3 py-2">
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm text-slate-100">
                  {selSector.name}
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-slate-500">
                    {selSector.band} · cap {selSector.capacity}
                  </span>
                </div>
                <button
                  onClick={() => setSelected(null)}
                  className="text-[11px] text-slate-500 hover:text-slate-300"
                >
                  clear ✕
                </button>
              </div>
              {selSeries && overview ? (
                <SectorTimeline
                  demand={selSeries}
                  capacity={selSector.capacity}
                  times={overview.times}
                  timeIndex={timeIndex}
                  onSeek={(ti) => {
                    setPlaying(false);
                    setTimeIndex(ti);
                  }}
                />
              ) : (
                <div className="py-3 text-center text-[11px] text-slate-500">
                  no traffic in this sector over the horizon
                </div>
              )}
            </div>
          )}

          <div className="flex border-b border-slate-800 text-sm">
            <TabBtn active={tab === "hotspots"} onClick={() => setTab("hotspots")}>
              Hotspots ({overview?.nOverDemandSectors ?? 0})
            </TabBtn>
            <TabBtn active={tab === "weather"} onClick={() => setTab("weather")}>
              Weather ({overview?.nConflicts ?? 0})
            </TabBtn>
            <TabBtn active={tab === "actions"} onClick={() => setTab("actions")}>
              Actions
            </TabBtn>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {tab === "hotspots" && (
              <>
                <div className="px-1 pb-2 text-xs text-slate-500">
                  Sectors exceeding capacity · {band} band
                </div>
                {bandHotspots.length === 0 && (
                  <div className="px-2 py-6 text-center text-xs text-slate-500">
                    No over-demand sectors in the {band} band this horizon.
                  </div>
                )}
                <ul className="space-y-1">
                  {bandHotspots.map((h) => (
                    <li key={h.name}>
                      <button
                        onClick={() => jumpToHotspot(h.name, h.peakTimeIndex, h.band)}
                        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left text-xs transition ${
                          selected === h.name
                            ? "border-sky-500 bg-sky-950/40"
                            : "border-slate-800 bg-slate-800/40 hover:border-slate-600"
                        }`}
                      >
                        <span className="font-mono text-slate-200">{h.name}</span>
                        <span className="ml-auto text-slate-400">
                          {h.peakDemand}/{h.capacity}
                        </span>
                        <span
                          className={`w-12 text-right font-bold ${
                            h.peakRatio >= 1.5 ? "text-red-400" : "text-orange-400"
                          }`}
                        >
                          {Math.round(h.peakRatio * 100)}%
                        </span>
                        <span className="w-14 text-right text-slate-500">
                          {fmtUTC(h.peakTime)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {tab === "weather" && (
              <>
                <div className="px-1 pb-2 text-xs text-slate-500">
                  Flights penetrating convective hazard (≥40 dBZ at altitude)
                </div>
                {conflicts.length === 0 && (
                  <div className="px-2 py-6 text-center text-xs text-slate-500">
                    No weather conflicts this horizon.
                  </div>
                )}
                <ul className="space-y-1">
                  {conflicts.slice(0, 80).map((c) => (
                    <li key={c.id} className="flex items-stretch gap-1">
                      <button
                        onClick={() => jumpToConflict(c)}
                        className={`flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                          selectedFlight === c.id
                            ? "border-fuchsia-500 bg-fuchsia-950/30"
                            : "border-slate-800 bg-slate-800/40 hover:border-slate-600"
                        }`}
                      >
                        <span className="font-mono text-slate-200">
                          {c.flightNumber}
                        </span>
                        <span className="text-slate-500">
                          {c.origin}→{c.dest}
                        </span>
                        <span className="ml-auto text-slate-400">
                          FL{Math.round(c.altFt / 100)}
                        </span>
                        <span className="w-12 text-right font-bold text-red-400">
                          {c.hazardMinutes}m
                        </span>
                        <span className="w-10 text-right text-fuchsia-300">
                          {c.maxDbz}
                        </span>
                      </button>
                      <a
                        href={flightAwareUrl(c.flightNumber)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Track ${c.flightNumber} on FlightAware`}
                        className="flex items-center rounded-md border border-slate-800 bg-slate-800/40 px-2 text-xs text-slate-500 hover:border-sky-600 hover:text-sky-300"
                      >
                        ↗
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {tab === "actions" && (
              <ActionsPanel
                recs={recs}
                selectedFlight={selectedFlight}
                selectedSector={selected}
                onWeatherRec={(id) => {
                  const c = conflicts.find((x) => x.id === id);
                  if (c) jumpToConflict(c);
                }}
                onSectorRec={(name) => {
                  const h = (overview?.hotspots ?? []).find(
                    (x) => x.name === name,
                  );
                  if (h) jumpToHotspot(h.name, h.peakTimeIndex, h.band);
                }}
              />
            )}
          </div>
        </aside>
      </div>

      <footer className="flex items-center gap-4 border-t border-slate-800 bg-slate-900/80 px-5 py-3">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-600 text-white hover:bg-sky-500"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <div className="w-28 font-mono text-sm text-slate-200">
          {fmtUTC(curTime)}
          <span className="ml-2 text-xs text-slate-500">
            +{((timeIndex * (overview?.stepMinutes ?? 5)) / 60).toFixed(1)}h
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(0, nSteps - 1)}
          value={timeIndex}
          onChange={(e) => {
            setPlaying(false);
            setTimeIndex(Number(e.target.value));
          }}
          className="h-1 flex-1 cursor-pointer appearance-none rounded bg-slate-700 accent-sky-500"
        />
        <div className="w-52 text-right text-xs text-slate-400">
          <span className="font-mono text-slate-200">{airborneNow}</span> airborne ·{" "}
          <span
            className={
              overNow > 0 ? "font-mono font-bold text-red-400" : "font-mono text-emerald-400"
            }
          >
            {overNow}
          </span>{" "}
          over ·{" "}
          <span
            className={
              nInHazardNow > 0
                ? "font-mono font-bold text-fuchsia-400"
                : "font-mono text-emerald-400"
            }
          >
            {nInHazardNow}
          </span>{" "}
          in wx
        </div>
      </footer>
    </div>
  );
};

function ActionsPanel({
  recs,
  selectedFlight,
  selectedSector,
  onWeatherRec,
  onSectorRec,
}: {
  recs: RecommendationsResp | null;
  selectedFlight: string | null;
  selectedSector: string | null;
  onWeatherRec: (id: string) => void;
  onSectorRec: (name: string) => void;
}) {
  if (!recs)
    return (
      <div className="px-2 py-6 text-center text-xs text-slate-500">
        computing mitigations…
      </div>
    );
  const s = recs.summary;
  return (
    <div className="space-y-3">
      {/* headline */}
      <div className="grid grid-cols-2 gap-2">
        <SumCard
          big={`${s.clearableByDelay}/${s.nConflicts}`}
          label="weather conflicts clearable by delay"
          accent="emerald"
        />
        <SumCard
          big={`${s.medianDelayMin}m`}
          label="median delay needed"
          accent="sky"
        />
        <SumCard
          big={`${s.needReroute}`}
          label="need lateral reroute"
          accent={s.needReroute > 0 ? "amber" : "emerald"}
        />
        <SumCard
          big={`${s.excessGroundHoldable}/${s.totalExcessFlights}`}
          label="excess sector-flights ground-holdable"
          accent="sky"
        />
      </div>

      <div className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Weather — departure delays
      </div>
      <ul className="space-y-1">
        {recs.weather.slice(0, 60).map((w) => (
          <li key={w.id}>
            <button
              onClick={() => onWeatherRec(w.id)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                selectedFlight === w.id
                  ? "border-fuchsia-500 bg-fuchsia-950/30"
                  : "border-slate-800 bg-slate-800/40 hover:border-slate-600"
              }`}
            >
              <span className="font-mono text-slate-200">{w.flightNumber}</span>
              <span className="text-slate-500">
                {w.origin}→{w.dest}
              </span>
              <span className="ml-auto text-slate-500">
                {w.beforeHazardMin}m in wx
              </span>
              {w.delayMin == null ? (
                <span className="w-20 rounded bg-amber-900/60 px-1.5 py-0.5 text-right font-semibold text-amber-300">
                  reroute
                </span>
              ) : (
                <span className="w-20 rounded bg-emerald-900/50 px-1.5 py-0.5 text-right font-semibold text-emerald-300">
                  +{w.delayMin}m → 0
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <div className="px-1 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        Sectors — metering to capacity
      </div>
      <ul className="space-y-1">
        {recs.sectors.map((r) => (
          <li key={r.sector}>
            <button
              onClick={() => onSectorRec(r.sector)}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition ${
                selectedSector === r.sector
                  ? "border-sky-500 bg-sky-950/40"
                  : "border-slate-800 bg-slate-800/40 hover:border-slate-600"
              }`}
            >
              <span className="font-mono text-slate-200">{r.sector}</span>
              <span className="text-slate-500">{r.peakTime.slice(11, 16)}Z</span>
              <span className="ml-auto rounded bg-red-900/50 px-1.5 py-0.5 font-semibold text-red-300">
                {r.peakDemand} → {r.capacity}
              </span>
              <span className="w-16 text-right text-slate-400">
                hold {Math.min(r.excess, r.groundHoldable)}/{r.excess}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SumCard({
  big,
  label,
  accent,
}: {
  big: string;
  label: string;
  accent: "sky" | "emerald" | "amber" | "red";
}) {
  const color =
    accent === "red"
      ? "text-red-400"
      : accent === "emerald"
        ? "text-emerald-400"
        : accent === "amber"
          ? "text-amber-400"
          : "text-sky-400";
  return (
    <div className="rounded-md border border-slate-800 bg-slate-800/40 px-3 py-2">
      <div className={`text-lg font-bold ${color}`}>{big}</div>
      <div className="text-[10px] leading-tight text-slate-500">{label}</div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 text-xs font-medium ${
        active
          ? "border-b-2 border-sky-500 text-sky-300"
          : "text-slate-400 hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent?: "sky" | "red" | "emerald" | "amber";
}) {
  const color =
    accent === "red"
      ? "text-red-400"
      : accent === "emerald"
        ? "text-emerald-400"
        : accent === "amber"
          ? "text-amber-400"
          : accent === "sky"
            ? "text-sky-400"
            : "text-slate-100";
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className={`text-base font-bold ${color}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </span>
    </div>
  );
}

function Legend() {
  const demand = [
    { c: "rgba(51,65,85,0.6)", t: "idle" },
    { c: "rgb(34,197,94)", t: "ok" },
    { c: "rgb(234,179,8)", t: "busy" },
    { c: "rgb(249,115,22)", t: "near" },
    { c: "rgb(239,68,68)", t: "over" },
  ];
  return (
    <div className="flex flex-col gap-1 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-1.5 text-[10px] text-slate-300">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-slate-500">demand</span>
        {demand.map((s) => (
          <span key={s.t} className="flex items-center gap-0.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: s.c }}
            />
            {s.t}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="mr-1 text-slate-500">weather</span>
        <span className="text-[9px] text-slate-500">20</span>
        <span
          className="inline-block h-2.5 w-24 rounded-sm"
          style={{
            background:
              "linear-gradient(to right, rgb(48,18,59), rgb(57,118,233), rgb(29,168,255), rgb(38,212,167), rgb(108,229,107), rgb(176,237,55), rgb(252,191,28), rgb(238,86,38), rgb(122,4,3))",
          }}
        />
        <span className="text-[9px] text-slate-500">60+ dBZ</span>
        <span className="ml-1 flex items-center gap-0.5">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          flt in wx
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="mr-1 text-slate-500">altitude</span>
        <span className="text-[9px] text-slate-500">0</span>
        <span
          className="inline-block h-2.5 w-24 rounded-sm"
          style={{
            background:
              "linear-gradient(to right, rgb(68,1,84), rgb(49,104,142), rgb(31,158,137), rgb(110,206,88), rgb(253,231,37))",
          }}
        />
        <span className="text-[9px] text-slate-500">FL450</span>
      </div>
    </div>
  );
}

export default App;
