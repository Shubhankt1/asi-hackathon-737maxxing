import React from "react";

interface Props {
  demand: number[];
  capacity: number;
  times: string[];
  timeIndex: number;
  onSeek: (ti: number) => void;
}

const W = 336;
const H = 96;
const PADL = 26;
const PADB = 14;
const PADT = 6;

/** Inline SVG bar chart of sector demand over the horizon vs capacity. */
export function SectorTimeline({
  demand,
  capacity,
  times,
  timeIndex,
  onSeek,
}: Props) {
  const n = demand.length;
  if (!n) return null;
  const peak = Math.max(capacity, ...demand);
  const maxY = peak * 1.12;
  const plotW = W - PADL - 4;
  const plotH = H - PADB - PADT;
  const bw = plotW / n;
  const yOf = (v: number) => PADT + plotH - (v / maxY) * plotH;
  const capY = yOf(capacity);

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ti = Math.round(((px - PADL) / plotW) * (n - 1));
    onSeek(Math.max(0, Math.min(n - 1, ti)));
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full cursor-pointer"
      onClick={handleClick}
    >
      {/* y axis labels */}
      <text x={2} y={yOf(0) + 3} fontSize="8" fill="#64748b">
        0
      </text>
      <text x={2} y={yOf(peak) + 3} fontSize="8" fill="#64748b">
        {peak}
      </text>

      {/* bars */}
      {demand.map((d, i) => {
        if (d <= 0) return null;
        const over = d > capacity;
        return (
          <rect
            key={i}
            x={PADL + i * bw}
            y={yOf(d)}
            width={Math.max(0.8, bw - 0.3)}
            height={yOf(0) - yOf(d)}
            fill={over ? "#ef4444" : "#38bdf8"}
            opacity={over ? 0.95 : 0.65}
          />
        );
      })}

      {/* capacity line */}
      <line
        x1={PADL}
        y1={capY}
        x2={W - 4}
        y2={capY}
        stroke="#fbbf24"
        strokeWidth="1"
        strokeDasharray="4 3"
      />
      <text x={W - 4} y={capY - 2} fontSize="8" fill="#fbbf24" textAnchor="end">
        cap {capacity}
      </text>

      {/* current-time marker */}
      <line
        x1={PADL + timeIndex * bw}
        y1={PADT}
        x2={PADL + timeIndex * bw}
        y2={yOf(0)}
        stroke="#e2e8f0"
        strokeWidth="1"
      />

      {/* x ticks: first / mid / last hour labels */}
      {[0, Math.floor(n / 2), n - 1].map((i) => (
        <text
          key={i}
          x={PADL + i * bw}
          y={H - 2}
          fontSize="8"
          fill="#64748b"
          textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
        >
          {times[i] ? times[i].slice(11, 16) : ""}
        </text>
      ))}
    </svg>
  );
}
