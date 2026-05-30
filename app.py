"""
app.py — Streamlit dashboard

Run with:
    streamlit run app.py
"""

import numpy as np
import streamlit as st
import plotly.graph_objects as go

from data_loader import load_scenario, SCENARIOS, LAT_MIN, LAT_MAX, LON_MIN, LON_MAX, ROWS, COLS
from analyzer import build_time_grid, interpolate_positions

# ---------------------------------------------------------------------------
# Page config + CSS
# ---------------------------------------------------------------------------

st.set_page_config(
    page_title="NAS Traffic Analyzer",
    page_icon="✈",
    layout="wide",
)

st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

    /* ── Hide Streamlit chrome ── */
    #MainMenu, footer                      { visibility: hidden; height: 0; }
    header                                 { background: transparent !important; }
    [data-testid="stToolbar"]              { display: none !important; }
    [data-testid="stSidebarCollapseButton"]{ display: none !important; }
    [data-testid="collapsedControl"]       { display: none !important; }

    /* ── Main area: full width, zero padding ── */
    .block-container                           { padding: 0 !important; max-width: 100% !important; }
    [data-testid="stAppViewContainer"]         { padding: 0 !important; }
    /* Zero gap only in main content, not sidebar */
    section.main [data-testid="stVerticalBlock"] { gap: 0 !important; }
    /* Pull main section back to left edge */
    section.main                               { margin-left: 0 !important; padding-left: 0 !important; }

    /* ── Sidebar: fixed overlay — doesn't consume layout space ── */
    [data-testid="stSidebar"] {
        position: fixed !important;
        top: 0 !important;
        left: 0 !important;
        height: auto !important;
        background: transparent !important;
        border: none !important;
        box-shadow: none !important;
        min-width: 210px !important;
        max-width: 210px !important;
        z-index: 100 !important;
    }
    section[data-testid="stSidebar"] > div {
        background: transparent !important;
    }
    [data-testid="stSidebarContent"] {
        background: transparent !important;
        padding: 14px 10px !important;
    }

    /* ── Glass card: targets st.container(border=True) wrapper ── */
    [data-testid="stSidebar"] [data-testid="stVerticalBlockBorderWrapper"] {
        background: rgba(6, 8, 18, 0.88) !important;
        border: 1px solid rgba(96, 165, 250, 0.18) !important;
        border-radius: 8px !important;
        padding: 13px 14px 12px 14px !important;
        backdrop-filter: blur(14px) !important;
        margin-bottom: 10px !important;
    }
    /* Remove Streamlit's default border so ours takes over */
    [data-testid="stSidebar"] [data-testid="stVerticalBlockBorderWrapper"] > div {
        border: none !important;
        padding: 0 !important;
        gap: 10px !important;
    }

    /* ── Sidebar typography ── */
    [data-testid="stSidebar"] label,
    [data-testid="stSidebar"] p,
    [data-testid="stSidebar"] span {
        font-family: 'Inter', sans-serif !important;
        font-size: 0.78rem !important;
        color: rgba(255,255,255,0.78) !important;
    }
    [data-testid="stSidebar"] [data-testid="stCheckbox"] { padding: 2px 0 !important; }
    [data-testid="stSidebar"] [data-testid="stRadio"] > div { gap: 3px !important; }
    [data-testid="stSidebar"] [data-testid="stSelectbox"] > div > div {
        background: rgba(255,255,255,0.05) !important;
        border: 1px solid rgba(96,165,250,0.2) !important;
        border-radius: 5px !important;
        color: white !important;
        font-size: 0.75rem !important;
    }

    /* ── Card section title ── */
    .card-title {
        font-family: 'Inter', sans-serif;
        font-size: 0.57rem;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(96, 165, 250, 0.7);
        margin-bottom: 10px;
        display: block;
    }

    /* ── Full-viewport map ── */
    [data-testid="stPlotlyChart"] {
        position: fixed !important;
        top: 0 !important; left: 0 !important;
        width: 100vw !important; height: 100vh !important;
        z-index: 0 !important;
    }
    [data-testid="stPlotlyChart"] > div,
    [data-testid="stPlotlyChart"] iframe { width: 100% !important; height: 100% !important; }

    /* ── Selected flight detail card ── */
    .flight-card {
        position: fixed;
        top: 14px;
        left: 224px;
        z-index: 101;
        background: rgba(6, 8, 18, 0.92);
        border: 1px solid rgba(96, 165, 250, 0.35);
        border-radius: 8px;
        padding: 13px 15px;
        backdrop-filter: blur(14px);
        font-family: 'Inter', sans-serif;
        min-width: 200px;
        max-width: 240px;
    }
    .flight-card-title {
        font-size: 0.57rem;
        font-weight: 600;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(96, 165, 250, 0.7);
        margin-bottom: 8px;
    }
    .flight-card-number {
        font-size: 1.1rem;
        font-weight: 600;
        color: white;
        letter-spacing: 0.04em;
        margin-bottom: 4px;
    }
    .flight-card-route {
        font-size: 0.78rem;
        color: rgba(255,255,255,0.65);
        margin-bottom: 8px;
    }
    .flight-card-row {
        display: flex;
        justify-content: space-between;
        font-size: 0.7rem;
        color: rgba(255,255,255,0.4);
        margin-top: 3px;
    }
    .flight-card-row b { color: rgba(255,255,255,0.75); font-weight: 500; }
    .flight-card-dismiss {
        font-size: 0.62rem;
        color: rgba(96,165,250,0.5);
        margin-top: 10px;
        cursor: pointer;
    }

    /* ── Bottom bar: slider + stats ── */
    .bottom-bar {
        position: fixed;
        bottom: 0; left: 0; right: 0;
        z-index: 100;
        background: rgba(6, 8, 18, 0.90);
        backdrop-filter: blur(14px);
        border-top: 1px solid rgba(96, 165, 250, 0.12);
        padding: 0 20px 6px 20px;
        font-family: 'Inter', sans-serif;
    }
    /* Slider row */
    .slider-row {
        width: 100%;
        padding: 4px 0 0 0;
    }
    /* Stats row */
    .stats-row {
        display: flex;
        align-items: center;
        gap: 16px;
        padding-bottom: 2px;
    }
    .time-label {
        font-size: 0.76rem;
        font-weight: 600;
        color: rgba(96, 165, 250, 0.95);
        letter-spacing: 0.06em;
        white-space: nowrap;
        min-width: 170px;
    }
    .stat-sep  { width: 1px; height: 10px; background: rgba(255,255,255,0.1); flex-shrink: 0; }
    .stat-chip { font-size: 0.67rem; color: rgba(255,255,255,0.35); white-space: nowrap; }
    .stat-chip b { color: rgba(255,255,255,0.78); font-weight: 500; }

    /* ── Bottom slider strip ── */
    [data-testid="stSlider"] {
        position: fixed !important;
        bottom: 36px !important;
        left: 0 !important;
        right: 0 !important;
        z-index: 200 !important;
        padding: 0 24px !important;
        background: transparent !important;
        margin: 0 !important;
    }
    /* Hide the auto-generated slider label */
    [data-testid="stSlider"] label { display: none !important; }
</style>
""", unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Sidebar — glass card overlays (scenario, layers, sector band)
# ---------------------------------------------------------------------------

with st.sidebar:
    with st.container(border=True):
        st.markdown('<div class="card-title">Scenario</div>', unsafe_allow_html=True)
        scenario = st.selectbox(
            "scenario", SCENARIOS, index=4,
            label_visibility="collapsed",
        )

    with st.container(border=True):
        st.markdown('<div class="card-title">Layers</div>', unsafe_allow_html=True)
        show_flights = st.checkbox("Flights", value=True)
        show_sectors = st.checkbox("Sectors", value=True)
        show_weather = st.checkbox("Weather", value=True)

    with st.container(border=True):
        st.markdown('<div class="card-title">Sector Band</div>', unsafe_allow_html=True)
        sector_band = st.radio(
            "band", ["HIGH", "LOW", "Both"],
            index=0, label_visibility="collapsed",
        )


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

@st.cache_data(show_spinner="Loading scenario...")
def load(scenario: str):
    data = load_scenario(scenario)
    time_grid = build_time_grid(data.asked_at)
    positions = interpolate_positions(data.flights, time_grid)
    flight_lookup = {f.uid: f for f in data.flights}
    return data, time_grid, positions, flight_lookup

data, time_grid, positions, flight_lookup = load(scenario)

# t_idx placeholder — actual slider rendered after chart
t_idx = st.session_state.get("timeslider", 0)
selected_t = time_grid[min(t_idx, len(time_grid) - 1)]

# Read once — used by detail card, route layer, and click handler
selected_uid = st.session_state.get("selected_flight_uid")

# ---------------------------------------------------------------------------
# Selected flight detail card (fixed overlay, next to sidebar)
# ---------------------------------------------------------------------------

if selected_uid and selected_uid in flight_lookup:
    sel = flight_lookup[selected_uid]
    duration_min = int(sel.duration_s / 60)
    st.markdown(f"""
    <div class="flight-card">
        <div class="flight-card-title">Selected Flight</div>
        <div class="flight-card-number">{sel.flight_number}</div>
        <div class="flight-card-route">{sel.origin_icao} &nbsp;→&nbsp; {sel.destination_icao}</div>
        <div class="flight-card-row"><span>Altitude</span><b>{sel.cruise_altitude_ft:,.0f} ft</b></div>
        <div class="flight-card-row"><span>Speed</span><b>{sel.cruise_speed_kt} kt</b></div>
        <div class="flight-card-row"><span>Duration</span><b>{duration_min // 60}h {duration_min % 60}m</b></div>
        <div class="flight-card-row"><span>Waypoints</span><b>{len(sel.lats)}</b></div>
        <div class="flight-card-row"><span>Status</span><b>{"Airborne" if sel.is_airborne else "Scheduled"}</b></div>
        <div class="flight-card-dismiss">click flight again to deselect</div>
    </div>
    """, unsafe_allow_html=True)

# ---------------------------------------------------------------------------
# Build figure
# ---------------------------------------------------------------------------

fig = go.Figure()
fig.update_layout(
    geo=dict(
        scope="usa",
        showland=True,      landcolor="rgb(18, 18, 28)",
        showocean=True,     oceancolor="rgb(8, 8, 18)",
        showlakes=True,     lakecolor="rgb(8, 8, 18)",
        showsubunits=True,  subunitcolor="rgb(50, 50, 70)",
        showcountries=True, countrycolor="rgb(70, 70, 95)",
        bgcolor="rgb(8, 8, 18)",
        projection_type="albers usa",
    ),
    paper_bgcolor="rgb(8, 8, 18)",
    plot_bgcolor="rgb(8, 8, 18)",
    margin=dict(l=0, r=0, t=0, b=0),
    height=1200,
    clickmode="event+select",
    showlegend=True,
    legend=dict(
        x=0.01, y=0.99,
        xanchor="left", yanchor="top",
        bgcolor="rgba(6,8,18,0.82)",
        bordercolor="rgba(96,165,250,0.15)",
        borderwidth=1,
        font=dict(color="white", size=10),
    ),
)

# ---------------------------------------------------------------------------
# Layer: Weather
# ---------------------------------------------------------------------------

if show_weather:
    strip = data.get_strip_at(selected_t)
    if strip is not None:
        refc = strip.refc.copy().astype(float)
        refc[refc <= -50] = np.nan
        step = 4
        rows_idx = np.arange(0, ROWS, step)
        cols_idx = np.arange(0, COLS, step)
        sub = refc[np.ix_(rows_idx, cols_idx)]
        lats_grid = LAT_MAX - rows_idx / ROWS * (LAT_MAX - LAT_MIN)
        lons_grid = LON_MIN + cols_idx / COLS * (LON_MAX - LON_MIN)
        lon_mesh, lat_mesh = np.meshgrid(lons_grid, lats_grid)
        mask = ~np.isnan(sub) & (sub >= 20)
        fig.add_trace(go.Scattergeo(
            lat=lat_mesh[mask].ravel(),
            lon=lon_mesh[mask].ravel(),
            mode="markers",
            marker=dict(
                size=3, color=sub[mask].ravel(),
                colorscale="YlOrRd", cmin=20, cmax=65,
                colorbar=dict(
                    title=dict(text="dBZ", font=dict(color="white")),
                    thickness=10, len=0.3, x=0.99, y=0.85,
                    bgcolor="rgba(6,8,18,0.82)",
                    tickfont=dict(color="white", size=9),
                ),
                opacity=0.75,
            ),
            name="Weather",
            hovertemplate="refc: %{marker.color:.1f} dBZ<extra></extra>",
        ))

# ---------------------------------------------------------------------------
# Layer: Sectors
# ---------------------------------------------------------------------------

if show_sectors:
    bands = []
    if sector_band in ("HIGH", "Both"): bands.append("HIGH")
    if sector_band in ("LOW",  "Both"): bands.append("LOW")
    fill = {"HIGH": "rgba(100,180,255,0.07)", "LOW": "rgba(180,255,100,0.05)"}
    line = {"HIGH": "rgba(100,180,255,0.4)",  "LOW": "rgba(180,255,100,0.3)"}
    for band in bands:
        lats_all, lons_all = [], []
        for s in data.sectors:
            if not s.name.startswith(band): continue
            coords = list(s.geometry.exterior.coords)
            lats_all += [c[1] for c in coords] + [None]
            lons_all += [c[0] for c in coords] + [None]
        fig.add_trace(go.Scattergeo(
            lat=lats_all, lon=lons_all, mode="lines",
            line=dict(color=line[band], width=0.5),
            fill="toself", fillcolor=fill[band],
            name=f"{band} sectors", hoverinfo="skip",
        ))

# ---------------------------------------------------------------------------
# Layer: Flights
# ---------------------------------------------------------------------------

f_lats, f_lons, f_labels, f_alts, f_uids = [], [], [], [], []

if show_flights:
    for uid, track in positions.items():
        match = [(t, lat, lon) for t, lat, lon in track if t == selected_t]
        if not match: continue
        _, lat, lon = match[0]
        fl = flight_lookup[uid]
        f_lats.append(lat); f_lons.append(lon)
        f_alts.append(fl.cruise_altitude_ft)
        f_uids.append(uid)
        f_labels.append(
            f"{fl.flight_number}<br>"
            f"{fl.origin_icao} → {fl.destination_icao}<br>"
            f"Alt: {fl.cruise_altitude_ft:,.0f} ft"
        )
    fig.add_trace(go.Scattergeo(
        lat=f_lats, lon=f_lons, mode="markers",
        marker=dict(
            size=4, color=f_alts, colorscale="Viridis",
            cmin=0, cmax=45000,
            colorbar=dict(
                title=dict(text="Alt (ft)", font=dict(color="white")),
                thickness=10, len=0.3, x=0.99, y=0.45,
                bgcolor="rgba(6,8,18,0.82)",
                tickfont=dict(color="white", size=9),
            ),
            opacity=0.9,
        ),
        customdata=f_uids,
        text=f_labels,
        hovertemplate="%{text}<extra></extra>",
        name=f"Flights ({len(f_lats)})",
    ))

# ---------------------------------------------------------------------------
# Layer: Selected flight — planned route + trajectory
# ---------------------------------------------------------------------------

if selected_uid and selected_uid in flight_lookup:
    sel = flight_lookup[selected_uid]

    # 1. Full planned route (dim dashed line — the full path)
    fig.add_trace(go.Scattergeo(
        lat=sel.lats, lon=sel.lons,
        mode="lines",
        line=dict(color="rgba(96,165,250,0.25)", width=1.5, dash="dot"),
        name="Planned route",
        hoverinfo="skip",
        showlegend=True,
    ))

    # 2. Trajectory — positions already flown up to selected_t
    track = positions.get(selected_uid, [])
    traj = [(lat, lon) for t, lat, lon in track if t <= selected_t]
    if traj:
        traj_lats, traj_lons = zip(*traj)
        fig.add_trace(go.Scattergeo(
            lat=list(traj_lats), lon=list(traj_lons),
            mode="lines",
            line=dict(color="rgba(96,165,250,0.85)", width=2.5),
            name="Trajectory",
            hoverinfo="skip",
            showlegend=True,
        ))

    # 3. Current position dot
    cur = sel.position_at(selected_t)
    if cur:
        fig.add_trace(go.Scattergeo(
            lat=[cur[0]], lon=[cur[1]],
            mode="markers",
            marker=dict(size=10, color="rgba(96,165,250,1)",
                        symbol="circle", line=dict(color="white", width=1.5)),
            name=sel.flight_number,
            hovertemplate=f"{sel.flight_number} · {selected_t.strftime('%H:%M UTC')}<extra></extra>",
        ))

# ---------------------------------------------------------------------------
# Render chart + handle flight click
# ---------------------------------------------------------------------------

event = st.plotly_chart(
    fig,
    width="stretch",
    on_select="rerun",
    key="main_map",
)

# Extract clicked flight uid from customdata
if event and event.selection and event.selection.points:
    pt = event.selection.points[0]

    # Streamlit uses curve_number + point_number (not trace_index/point_index)
    click_key = f"{getattr(pt, 'curve_number', '')}-{getattr(pt, 'point_number', '')}"

    # customdata: Plotly returns a scalar string for 1-D customdata
    cd = getattr(pt, "customdata", None)
    uid = cd[0] if isinstance(cd, (list, tuple)) else cd

    if uid and click_key != st.session_state.get("_last_click_key"):
        st.session_state._last_click_key = click_key
        if st.session_state.get("selected_flight_uid") == uid:
            st.session_state.selected_flight_uid = None
        else:
            st.session_state.selected_flight_uid = uid
        st.rerun()

# Slider rendered AFTER chart so it sits above it in stacking order
t_idx = st.slider(
    "t", 0, len(time_grid) - 1, t_idx,
    label_visibility="collapsed",
    key="timeslider",
)

# ---------------------------------------------------------------------------
# Bottom bar: stats + time (slider is positioned via CSS above this)
# ---------------------------------------------------------------------------

active_count = len(f_lats) if show_flights else "—"
st.markdown(f"""
<div class="bottom-bar">
    <div class="stats-row" style="padding-top:44px;">
        <div class="time-label">{selected_t.strftime('%Y-%m-%d &nbsp;&nbsp; %H:%M UTC')}</div>
        <div class="stat-sep"></div>
        <div class="stat-chip">Flights <b>{active_count}</b></div>
        <div class="stat-sep"></div>
        <div class="stat-chip">Sectors <b>{len(data.sectors)}</b></div>
        <div class="stat-sep"></div>
        <div class="stat-chip">Wx strips <b>{len(data.weather_strips)}</b></div>
        <div class="stat-sep"></div>
        <div class="stat-chip">Step <b>{t_idx + 1} / {len(time_grid)}</b></div>
    </div>
</div>
""", unsafe_allow_html=True)
