import React, { useEffect, useMemo, useRef, useState } from "react";
import { GeoProjection } from "d3-geo";
import { SectorGeom, WxCell } from "./api";
import {
  demandFill,
  makeAlbersFit,
  pointInScreenRing,
  radarAlpha,
  radarCss,
  ratioLabel,
} from "./maputil";

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
}

interface Props {
  sectors: SectorGeom[];
  band: "HIGH" | "LOW";
  demandByName: Map<string, number[]>;
  timeIndex: number;
  onPick?: (name: string | null) => void;
  selected?: string | null;
  showWeather: boolean;
  weatherCells?: WxCell[];
  cellDeg?: { dLat: number; dLon: number };
  flightPoints?: FlightPoint[];
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

export function SectorMap({
  sectors,
  band,
  demandByName,
  timeIndex,
  onPick,
  selected,
  showWeather,
  weatherCells,
  cellDeg,
  flightPoints,
  selectedTrack,
  rerouteTrack,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hover, setHover] = useState<HoverState | null>(null);

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

    // 1) sector demand fills
    for (const ps of list) {
      const series = demandByName.get(ps.name);
      const d = series ? series[timeIndex] || 0 : 0;
      const ratio = d / ps.capacity;
      const pts = ps.pts;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 1; i < pts.length / 2; i++)
        ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
      ctx.closePath();
      ctx.fillStyle = demandFill(ratio);
      ctx.fill();
      ctx.lineWidth = ratio >= 1 ? 1.2 : 0.5;
      ctx.strokeStyle =
        ratio >= 1 ? "rgba(254,202,202,0.85)" : "rgba(148,163,184,0.18)";
      ctx.stroke();
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
      octx.globalCompositeOperation = "lighter"; // intensities build up
      for (const c of weatherCells) {
        const p = proj([c[1], c[0]]);
        if (!p) continue;
        octx.fillStyle = radarCss(c[2], radarAlpha(c[2]) * 0.5);
        octx.beginPath();
        octx.arc(p[0], p[1], blobR, 0, Math.PI * 2);
        octx.fill();
      }
      ctx.save();
      ctx.filter = `blur(${Math.max(3, cellPx * 1.3)}px)`;
      ctx.globalAlpha = 0.88;
      ctx.drawImage(off, 0, 0, size.w, size.h);
      ctx.restore();
    }

    // 3) selected flight route (dashed cyan)
    if (selectedTrack) {
      const tp = projectTrack(proj, selectedTrack.lats, selectedTrack.lons);
      if (tp.length > 1) {
        ctx.beginPath();
        tp.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = "rgba(56,189,248,0.9)";
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
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = "rgba(52,211,153,0.95)";
        ctx.stroke();
      }
    }

    // 4) conflict flight points
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
          ctx.strokeStyle = "rgba(255,255,255,0.9)";
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(251,191,36,0.7)";
          ctx.fill();
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
        ctx.lineWidth = 2.2;
        ctx.strokeStyle = "#38bdf8";
        ctx.stroke();
      }
    }
  }, [
    view,
    demandByName,
    timeIndex,
    size,
    selected,
    showWeather,
    weatherCells,
    cellDeg,
    flightPoints,
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
