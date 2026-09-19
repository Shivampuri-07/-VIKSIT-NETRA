import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar, Legend,
} from "recharts";
import type { DriftResult, EnvironmentState, CandidateRanking, VesselScoreDetail } from "../types";

interface Props {
  forward: DriftResult | null;
  backward: DriftResult | null;
  environment: EnvironmentState | null;
  attribution: CandidateRanking | null;
  selectedVessel: VesselScoreDetail | null;
}

const axis = { stroke: "#8B949E", fontSize: 9 };
const tip = { contentStyle: { background: "#161B22", border: "1px solid #30363D", fontSize: 10 }, labelStyle: { color: "#C9D1D9" } };
const FACTOR_COLORS = { spatial: "#58A6FF", temporal: "#79C0FF", trajectory: "#bc8cff", consistency: "#AFF5B4" };

const Card: React.FC<{ title: string; note?: string; children: React.ReactNode }> = ({ title, note, children }) => (
  <div className="bg-[#161B22] border border-[#30363D] rounded-[4px] p-2 flex flex-col min-w-0">
    <div className="text-[10px] font-semibold text-[#C9D1D9]">{title}</div>
    {note && <div className="text-[9px] text-[#8B949E] mb-1">{note}</div>}
    <div className="flex-1 min-h-0">{children}</div>
  </div>
);

export const AnalyticsPanel: React.FC<Props> = ({ forward, backward, environment, attribution, selectedVessel }) => {
  const fc = useMemo(() => (forward?.snapshots ?? []).map((s) => ({
    h: `T+${s.hours}h`, area: s.hull_area_km2, r90: s.r90_km, r50: s.r50_km, disp: s.displacement_km,
  })), [forward]);
  const bt = useMemo(() => (backward?.centroid_path ?? []).filter((_, i) => i % 2 === 0).map((c) => ({
    h: c.signed_hours, r90: c.r90_km, r50: c.r50_km,
  })), [backward]);
  const wind = useMemo(() => (environment?.wind_time_series ?? []).map((w) => ({
    t: w.time.slice(11, 16), speed: Number(w.speed_ms.toFixed(2)), from: Number(w.direction_from_deg.toFixed(0)),
  })), [environment]);
  const coverage = useMemo(() => {
    const row = (name: string, fr?: Record<string, number>) => ({
      name,
      REAL: fr?.["REAL"] ?? 0,
      PERSISTED: (fr?.["PERSISTED"] ?? 0) + (fr?.["PERSISTED+EDGE_CLAMPED"] ?? 0),
      EDGE_CLAMPED: fr?.["EDGE_CLAMPED"] ?? 0,
      OTHER: (fr?.["DEMO_CONSTANT"] ?? 0) + (fr?.["USER_OVERRIDE"] ?? 0) + (fr?.["NOT_AVAILABLE"] ?? 0),
    });
    return [
      row("Backtrack wind", backward?.forcing.wind_status_fractions),
      row("Forecast wind", forward?.forcing.wind_status_fractions),
      row("Backtrack current", backward?.forcing.current_status_fractions),
      row("Forecast current", forward?.forcing.current_status_fractions),
    ];
  }, [backward, forward]);
  const contrib = useMemo(() => (attribution?.top_candidates ?? []).slice(0, 8).map((c) => ({
    name: c.vessel_name.length > 16 ? c.vessel_name.slice(0, 15) + "…" : c.vessel_name,
    spatial: c.feature_breakdown.weighted_contributions?.spatial ?? 0,
    temporal: c.feature_breakdown.weighted_contributions?.temporal ?? 0,
    trajectory: c.feature_breakdown.weighted_contributions?.trajectory ?? 0,
    consistency: c.feature_breakdown.weighted_contributions?.consistency ?? 0,
  })), [attribution]);

  if (!forward && !backward) {
    return <div className="h-full flex items-center justify-center text-[11px] text-[#8B949E] font-mono">Run an investigation to populate analytics.</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-2">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <Card title="Forecast evolution — transport envelope" note="P90 particle-hull area (km²) and radii from the forward ensemble. No weathering.">
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={fc} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#21262D" />
              <XAxis dataKey="h" tick={axis} />
              <YAxis yAxisId="a" tick={axis} />
              <YAxis yAxisId="r" orientation="right" tick={axis} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Line yAxisId="a" type="monotone" dataKey="area" name="Envelope km²" stroke="#f0883e" dot />
              <Line yAxisId="r" type="monotone" dataKey="r90" name="P90 radius km" stroke="#d29922" dot />
              <Line yAxisId="r" type="monotone" dataKey="disp" name="Centroid displacement km" stroke="#58A6FF" dot />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Backtrack uncertainty growth" note="P50/P90 radius of the backward ensemble vs hours before the SAR observation.">
          <ResponsiveContainer width="100%" height={150}>
            <LineChart data={bt} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
              <CartesianGrid stroke="#21262D" />
              <XAxis dataKey="h" tick={axis} type="number" domain={["dataMin", 0]} />
              <YAxis tick={axis} />
              <Tooltip {...tip} />
              <Legend wrapperStyle={{ fontSize: 9 }} />
              <Line type="monotone" dataKey="r90" name="P90 km" stroke="#79C0FF" dot={false} />
              <Line type="monotone" dataKey="r50" name="P50 km" stroke="#3fb950" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Forcing data coverage" note="Fraction of drift-engine samples by provenance. Only REAL samples are observations/reanalysis.">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={coverage} layout="vertical" margin={{ top: 4, right: 8, left: 30, bottom: 0 }}>
              <CartesianGrid stroke="#21262D" />
              <XAxis type="number" domain={[0, 1]} tick={axis} />
              <YAxis type="category" dataKey="name" tick={axis} width={90} />
              <Tooltip {...tip} />
              <Bar dataKey="REAL" stackId="a" fill="#3fb950" />
              <Bar dataKey="PERSISTED" stackId="a" fill="#d29922" />
              <Bar dataKey="EDGE_CLAMPED" stackId="a" fill="#f0883e" />
              <Bar dataKey="OTHER" stackId="a" fill="#f85149" name="Demo / override / not available" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Environmental forcing — ERA5 at slick centroid" note={wind.length ? `${wind.length} native hourly fields available; values between/outside are interpolated/persisted.` : "No gridded wind product for this scene."}>
          {wind.length ? (
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={wind} margin={{ top: 4, right: 8, left: -10, bottom: 0 }}>
                <CartesianGrid stroke="#21262D" />
                <XAxis dataKey="t" tick={axis} />
                <YAxis yAxisId="s" tick={axis} />
                <YAxis yAxisId="d" orientation="right" domain={[0, 360]} tick={axis} />
                <Tooltip {...tip} />
                <Legend wrapperStyle={{ fontSize: 9 }} />
                <Line yAxisId="s" dataKey="speed" name="Wind speed m/s" stroke="#58A6FF" dot />
                <Line yAxisId="d" dataKey="from" name="Direction from °" stroke="#bc8cff" dot />
              </LineChart>
            </ResponsiveContainer>
          ) : <div className="text-[10px] text-[#8B949E] p-2">Not available.</div>}
          <div className="text-[9px] text-[#8B949E]">Current: {environment?.at_observation?.current_status === "NOT_AVAILABLE" ? "no product (not plotted)" : `${environment?.current_time_series?.length ?? 0} fields`}</div>
        </Card>

        <Card title="Evidence contributions — top candidates" note="Weighted factor contributions summing to each composite score (0–1).">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={contrib} layout="vertical" margin={{ top: 4, right: 8, left: 30, bottom: 0 }}>
              <XAxis type="number" domain={[0, 1]} tick={axis} />
              <YAxis type="category" dataKey="name" tick={axis} width={95} />
              <Tooltip {...tip} />
              <Bar dataKey="spatial" stackId="c" fill={FACTOR_COLORS.spatial} />
              <Bar dataKey="temporal" stackId="c" fill={FACTOR_COLORS.temporal} />
              <Bar dataKey="trajectory" stackId="c" fill={FACTOR_COLORS.trajectory} />
              <Bar dataKey="consistency" stackId="c" fill={FACTOR_COLORS.consistency} name="kinematic" />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Spill evolution" note="Observed area over time requires two or more SAR observations of the same slick.">
          <div className="text-[10px] text-[#8B949E] p-2 leading-relaxed">
            One SAR observation is available for this incident, so no observed time series can be drawn.
            The forecast-evolution chart shows <b>modelled</b> transport, which is not an observation.
            {selectedVessel && <div className="mt-2 text-[#C9D1D9]">Selected: <b>{selectedVessel.vessel_name}</b> — composite {selectedVessel.composite_score.toFixed(3)}{selectedVessel.baseline_offline_score != null ? `; 2018 offline baseline ${selectedVessel.baseline_offline_score.toFixed(3)}` : ""}.</div>}
          </div>
        </Card>
      </div>
    </div>
  );
};
