import React from "react";

/** Airspace Foresight mark: a jet ascending through forecast/radar arcs with a
 *  weather cell ahead. Pure SVG so it scales crisply from favicon to header. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Airspace Foresight"
    >
      <defs>
        <linearGradient id="afTile" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#11203a" />
          <stop offset="1" stopColor="#070d18" />
        </linearGradient>
        <linearGradient id="afPlane" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e0f2fe" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="46"
        height="46"
        rx="11"
        fill="url(#afTile)"
        stroke="#1e3a5f"
        strokeWidth="1"
      />
      <g transform="rotate(-30 24 24)">
        <g fill="none" stroke="#38bdf8" strokeLinecap="round">
          <path d="M 37.4 16.1 A 7 7 0 0 1 37.4 31.9" strokeWidth="1.6" opacity="0.85" />
          <path d="M 39.7 13.2 A 11 11 0 0 1 39.7 34.8" strokeWidth="1.4" opacity="0.5" />
          <path d="M 42.0 10.3 A 15 15 0 0 1 42.0 37.7" strokeWidth="1.2" opacity="0.28" />
        </g>
        <circle cx="40.5" cy="24" r="1.7" fill="#e23bd6" />
        <polygon points="34,24 9,12 20,24" fill="url(#afPlane)" />
        <polygon points="34,24 20,24 9,36" fill="#0ea5e9" />
        <polygon points="20,24 9,12 9,36" fill="#0b6fae" opacity="0.55" />
      </g>
    </svg>
  );
}
