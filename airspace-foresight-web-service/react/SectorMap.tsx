import React, { useEffect, useMemo, useRef, useState } from "react";
import { GeoProjection } from "d3-geo";
import { api, BasemapResp, SectorGeom, WxCell } from "./api";
import {
  COAST_BORDER,
  demandFill,
  LAND_FILL,
  makeAlbersFit,
  MAP_BG,
  pointInScreenRing,
  ratioLabel,
  STATE_BORDER,
  turboCss,
  viridisAlt,
} from "./maputil";

// Offline US basemap geometry is identical across the whole app, so fetch once.
let _basemapCache: BasemapResp | null = null;

// In "alerts" color mode, a sector is "high density" at/above this load ratio.
const ALERT_RATIO = 0.85;

interface ProjectedSector {
  name: string;
  capacity: number;
  pts: Float64Array;
  sbbox: [number, number, number, number];
}

export interface FlightPoint {
  lon: number;
  lat: number;
  hazard: boolean;
  id: string;
  altFt?: number; // cruise altitude -> Viridis marker color (Python-map style)
}

export type SectorColorMode = "all" | "alerts" | "off";

interface Props {
  sectors: SectorGeom[];
  band: "HIGH" | "LOW";
  demandByName: Map<string, number[]>;
  timeIndex: number;
  colorMode?: SectorColorMode; // all sectors / alerts only / no coloring
  onPick?: (name: string | null) => void;
  selected?: string | null;
  showWeather: boolean;
  weatherCells?: WxCell[];
  cellDeg?: { dLat: number; dLon: number };
  flightPoints?: FlightPoint[];
  denseFlights?: boolean; // many points (all-flights mode) -> smaller/fainter dots
  selectedTrack?: { lats: number[]; lons: number[] } | null;
  rerouteTrack?: { lats: number[]; lons: number[] } | null;
}

interface HoverState {
  name: string;
  ratio: number;
  demand: number;
  capacity: number;
  x: number;
  y: number;
}

function projectTrack(
  proj: GeoProjection,
  lats: number[],
  lons: number[],
): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < lats.length; i++) {
    const p = proj([lons[i], lats[i]]);
    if (p) out.push(p as [number, number]);
  }
  return out;
}

// Project a GeoJSON (Multi)Polygon into screen-space rings (flat [x0,y0,x1,y1,...]).
function projectGeom(proj: GeoProjection, geom: any): number[][] {
  const rings: number[][] = [];
  const addPoly = (poly: number[][][]) => {
    for (const ring of poly) {
      const xy: number[] = [];
      for (const [lon, lat] of ring) {
        const p = proj([lon, lat]);
        if (p) xy.push(p[0], p[1]);
      }
      if (xy.length >= 6) rings.push(xy);
    }
  };
  if (!geom) return rings;
  if (geom.type === "Polygon") addPoly(geom.coordinates);
  else if (geom.type === "MultiPolygon")
    for (const poly of geom.coordinates) addPoly(poly);
  return rings;
}

function tracePath(ctx: CanvasRenderingContext2D, r: number[]) {
  ctx.moveTo(r[0], r[1]);
  for (let i = 1; i < r.length / 2; i++) ctx.lineTo(r[i * 2], r[i * 2 + 1]);
  ctx.closePath();
}

export function SectorMap({
  sectors,
  band,
  demandByName,
  timeIndex,
  colorMode = "all",
  onPick,
  selected,
  showWeather,
  weatherCells,
  cellDeg,
  flightPoints,
  denseFlights,
  selectedTrack,
  rerouteTrack,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<HoverState | null>(null);
  const [basemap, setBasemap] = useState<BasemapResp | null>(_basemapCache);

  useEffect(() => {
    if (_basemapCache) return;
    api.basemap().then((b) => {
      _basemapCache = b;
      setBasemap(b);
    });
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(320, r.width), h: Math.max(320, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bandSectors = useMemo(
    () => sectors.filter((s) => s.band === band),
    [sectors, band],
  );

  const view = useMemo<{ proj: GeoProjection; list: ProjectedSector[] } | null>(() => {
    if (!bandSectors.length) return null;
    const proj = makeAlbersFit(
      bandSectors.map((s) => s.ring),
      size.w,
      size.h,
      14,
    );
    const list: ProjectedSector[] = [];
    for (const s of bandSectors) {
      const xy: number[] = [];
      let minx = Infinity,
        miny = Infinity,
        maxx = -Infinity,
        maxy = -Infinity;
      for (const [lon, lat] of s.ring) {
        const p = proj([lon, lat]);
        if (!p) continue;
        xy.push(p[0], p[1]);
        if (p[0] < minx) minx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] > maxy) maxy = p[1];
      }
      if (xy.length < 6) continue;
      list.push({
        name: s.name,
        capacity: s.capacity,
        pts: Float64Array.from(xy),
        sbbox: [minx, miny, maxx, maxy],
      });
    }
    return { proj, list };
  }, [bandSectors, size.w, size.h]);

  // Project the offline US basemap once per projection (resize / band change).
  const base = useMemo<{ nation: number[][]; states: number[][] } | null>(() => {
    if (!view || !basemap) return null;
    const nation: number[][] = [];
    const states: number[][] = [];
    for (const f of basemap.nation.features)
      nation.push(...projectGeom(view.proj, f.geometry));
    for (const f of basemap.states.features)
      states.push(...projectGeom(view.proj, f.geometry));
    return { nation, states };
  }, [view, basemap]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !view) return;
    const { proj, list } = view;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.lineJoin = "round";

    // 0) dark "dark-matter"-style basemap: water background + CONUS land fill,
    //    with a faint coastline so the continent edge reads against the water.
    ctx.fillStyle = MAP_BG;
    ctx.fillRect(0, 0, size.w, size.h);
    if (base) {
      ctx.fillStyle = LAND_FILL;
      for (const r of base.nation) {
        ctx.beginPath();
        tracePath(ctx, r);
        ctx.fill();
      }
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = COAST_BORDER;
      for (const r of base.nation) {
        ctx.beginPath();
        tracePath(ctx, r);
        ctx.stroke();
      }
    }

    // 1) sector demand fills (translucent over the basemap). Which sectors are
    //    colored depends on colorMode: "all", none ("off"), or only the alert
    //    sectors ("alerts" = high density OR overlapping convective weather).
    if (colorMode !== "off") {
      // sectors overlapping hazardous (>=40 dBZ) weather, for "alerts" mode
      let badWx: Set<string> | null = null;
      if (colorMode === "alerts" && showWeather && weatherCells?.length) {
        badWx = new Set();
        const haz: [number, number][] = [];
        for (const c of weatherCells) {
          if (c[2] < 40) continue;
          const p = proj([c[1], c[0]]);
          if (p) haz.push(p as [number, number]);
        }
        for (const ps of list) {
          const [minx, miny, maxx, maxy] = ps.sbbox;
          for (const [hx, hy] of haz) {
            if (hx < minx || hx > maxx || hy < miny || hy > maxy) continue;
            if (pointInScreenRing(hx, hy, ps.pts)) {
              badWx.add(ps.name);
              break;
            }
          }
        }
      }

      for (const ps of list) {
        const series = demandByName.get(ps.name);
        const d = series ? series[timeIndex] || 0 : 0;
        const ratio = d / ps.capacity;
        // in "alerts" mode show only high-density (near/over capacity) or
        // bad-weather sectors; "all" shows everything.
        if (
          colorMode === "alerts" &&
          ratio < ALERT_RATIO &&
          !(badWx?.has(ps.name) ?? false)
        )
          continue;
        const pts = ps.pts;
        ctx.beginPath();
        ctx.moveTo(pts[0], pts[1]);
        for (let i = 1; i < pts.length / 2; i++)
          ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
        ctx.closePath();
        ctx.fillStyle = demandFill(ratio);
        ctx.fill();
        ctx.lineWidth = ratio >= 1 ? 1.2 : 0.4;
        ctx.strokeStyle =
          ratio >= 1 ? "rgba(254,202,202,0.85)" : "rgba(148,163,184,0.16)";
        ctx.stroke();
      }
    }

    // 1b) US state borders on top of the choropleth, so the country geography
    //     reads through the (translucent) demand mosaic — the carto-positron look.
    if (base) {
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = STATE_BORDER;
      for (const r of base.states) {
        ctx.beginPath();
        tracePath(ctx, r);
        ctx.stroke();
      }
    }

    // 2) weather precipitation — drawn to an offscreen layer as additive blobs
    //    then blurred + composited, so scattered radar cells merge into smooth
    //    glowing storm regions that read clearly above the demand map.
    if (showWeather && weatherCells && weatherCells.length && cellDeg) {
      let cellPx = 6;
      const a0 = proj([weatherCells[0][1], weatherCells[0][0]]);
      const b0 = proj([
        weatherCells[0][1] + cellDeg.dLon,
        weatherCells[0][0] - cellDeg.dLat,
      ]);
      if (a0 && b0) cellPx = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]) || 6;
      const blobR = Math.max(7, cellPx * 2.4);

      const off = document.createElement("canvas");
      off.width = size.w;
      off.height = size.h;
      const octx = off.getContext("2d")!;
      // turbo density: additive blobs so overlapping cells build up and glow
      // like radar against the dark basemap, blurred into smooth storm cores.
      octx.globalCompositeOperation = "lighter";
      for (const c of weatherCells) {
        const p = proj([c[1], c[0]]);
        if (!p) continue;
        octx.fillStyle = turboCss(c[2], 0.45);
        octx.beginPath();
        octx.arc(p[0], p[1], blobR, 0, Math.PI * 2);
        octx.fill();
      }
      ctx.save();
      ctx.filter = `blur(${Math.max(3, cellPx * 1.3)}px)`;
      ctx.globalAlpha = 0.9;
      ctx.drawImage(off, 0, 0, size.w, size.h);
      ctx.restore();
    }

    // 3) selected flight route (dashed cyan)
    if (selectedTrack) {
      const tp = projectTrack(proj, selectedTrack.lats, selectedTrack.lons);
      if (tp.length > 1) {
        ctx.beginPath();
        tp.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = "rgba(56,189,248,0.95)"; // bright cyan on dark
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 3b) reroute path (solid green)
    if (rerouteTrack && rerouteTrack.lats.length) {
      const rp = projectTrack(proj, rerouteTrack.lats, rerouteTrack.lons);
      if (rp.length > 1) {
        ctx.beginPath();
        rp.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "rgba(52,211,153,0.97)"; // bright green on dark
        ctx.stroke();
      }
    }

    // 4) flight points — colored by cruise altitude (Viridis), like the Python
    //    map; hazard flights stay emphasized in red.
    if (flightPoints) {
      for (const fp of flightPoints) {
        const p = proj([fp.lon, fp.lat]);
        if (!p) continue;
        if (fp.hazard) {
          ctx.beginPath();
          ctx.arc(p[0], p[1], 3.4, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.lineWidth = 1;
          ctx.strokeStyle = "rgba(255,255,255,0.9)"; // white halo on dark
          ctx.stroke();
        } else {
          const r = denseFlights ? 1.5 : 2.4;
          ctx.beginPath();
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          ctx.fillStyle = viridisAlt(fp.altFt ?? 30000);
          ctx.fill();
          // faint light outline keeps the dark (low-altitude) end of the
          // Viridis ramp visible against the dark basemap
          ctx.lineWidth = denseFlights ? 0.5 : 0.6;
          ctx.strokeStyle = "rgba(226,232,240,0.35)";
          ctx.stroke();
        }
      }
    }

    // 5) selected sector outline
    if (selected) {
      const ps = list.find((p) => p.name === selected);
      if (ps) {
        ctx.beginPath();
        ctx.moveTo(ps.pts[0], ps.pts[1]);
        for (let i = 1; i < ps.pts.length / 2; i++)
          ctx.lineTo(ps.pts[i * 2], ps.pts[i * 2 + 1]);
        ctx.closePath();
        ctx.lineWidth = 2.4;
        ctx.strokeStyle = "#38bdf8";
        ctx.stroke();
      }
    }
  }, [
    view,
    base,
    demandByName,
    timeIndex,
    colorMode,
    size,
    selected,
    showWeather,
    weatherCells,
    cellDeg,
    flightPoints,
    denseFlights,
    selectedTrack,
    rerouteTrack,
  ]);

  function hitTest(mx: number, my: number): ProjectedSector | null {
    if (!view) return null;
    for (const ps of view.list) {
      const [minx, miny, maxx, maxy] = ps.sbbox;
      if (mx < minx || mx > maxx || my < miny || my > maxy) continue;
      if (pointInScreenRing(mx, my, ps.pts)) return ps;
    }
    return null;
  }

  function onMove(e: React.MouseEvent) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const ps = hitTest(mx, my);
    if (!ps) {
      setHover(null);
      return;
    }
    const series = demandByName.get(ps.name);
    const d = series ? series[timeIndex] || 0 : 0;
    setHover({
      name: ps.name,
      demand: d,
      capacity: ps.capacity,
      ratio: d / ps.capacity,
      x: mx,
      y: my,
    });
  }

  return (
    <div ref={wrapRef} className="relative w-full h-full">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 cursor-crosshair"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => onPick?.(hover?.name ?? null)}
      />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-slate-600 bg-slate-900/95 px-3 py-2 text-xs shadow-xl"
          style={{
            left: Math.min(hover.x + 14, size.w - 170),
            top: Math.max(hover.y - 10, 8),
          }}
        >
          <div className="font-semibold text-slate-100">{hover.name}</div>
          <div className="text-slate-300">
            demand <span className="font-mono text-slate-100">{hover.demand}</span> / cap{" "}
            <span className="font-mono text-slate-100">{hover.capacity}</span>
          </div>
          <div
            className={
              hover.ratio >= 1
                ? "font-bold text-red-400"
                : hover.ratio >= 0.7
                  ? "text-amber-300"
                  : "text-emerald-300"
            }
          >
            {(hover.ratio * 100).toFixed(0)}% · {ratioLabel(hover.ratio)}
          </div>
        </div>
      )}
    </div>
  );
}
