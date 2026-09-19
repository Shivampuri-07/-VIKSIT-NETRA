import React, { useEffect, useRef, useState } from "react";
import { Layers, Eye, EyeOff, Maximize2, Minimize2, Compass, Download, Route, Wind, Waves, Target, Crosshair, Milestone, ScanSearch, Play, Pause, SkipBack, SkipForward, ChevronDown, ChevronUp, Info, TriangleAlert } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type {
  Scene, SpillDetection, DriftSimulation, CandidateRanking, VesselScoreDetail, DriftResult, EnvironmentState, GridVector,
} from "../types";
import { fmtLat, fmtLon, fmtLatLon, fmt, utc, horizonColor, statusColor } from "../lib/format";

interface GisMapProps {
  scene: Scene | null;
  detection: SpillDetection | null;
  drift: DriftSimulation | null;
  forward: DriftResult | null;
  environment: EnvironmentState | null;
  attribution: CandidateRanking | null;
  selectedVessel: VesselScoreDetail | null;
  onSelectVessel: (vessel: VesselScoreDetail | null) => void;
  /** Called with the viewer state the report must reflect. */
  onDownloadReport: (ctx: { horizon: number | "ALL" }) => void;
  reportEnabled: boolean;
  reportDisabledReason?: string;
  /** Focus-map mode: the parent enlarges the container; the map stays mounted so layers/time/horizon are preserved. */
  focusMode?: boolean;
  onToggleFocus?: () => void;
}

type LayerKey = "sar" | "spill" | "reference" | "backtrack" | "origin" | "forecast" | "wind" | "current" | "ais";
const LAYER_LABELS: Record<LayerKey, string> = {
  sar: "SAR Frame", spill: "Slick (model)", reference: "Reference label", backtrack: "Backtrack", origin: "Origin Zone", forecast: "Forecast", wind: "Wind", current: "Current", ais: "AIS",
};
const LAYER_HINTS: Record<LayerKey, string> = {
  sar: "Footprint of the SAR scene",
  spill: "MODEL_PREDICTION: slick polygons vectorised from the frozen U-Net output",
  reference: "REFERENCE_LABEL: labelled mask, evaluation only - not a model prediction",
  backtrack: "Backward Lagrangian particle paths and ensemble-centroid path",
  origin: "Probable origin zone (P90 particle hull); a region, not a point",
  forecast: "Forward drift impact zones per horizon (scenario unless forcing supports it)",
  wind: "ERA5 10 m wind vectors at the observation time",
  current: "Surface current vectors at the observation time",
  ais: "AIS tracks of ranked candidate vessels (leads, not proof)",
};
const LAYER_COLORS: Record<LayerKey, string> = {
  sar: "#58A6FF", spill: "#FF4444", reference: "#e3b341", backtrack: "#00D9FF", origin: "#79C0FF", forecast: "#f0883e", wind: "#e3b341", current: "#56d4dd", ais: "#AFF5B4",
};

const RAD = Math.PI / 180;
/** Guards every fly/zoom target: rejects NaN and the (0,0) "null island" sentinel. */
export const validLatLon = (p?: number[] | null): p is [number, number] =>
  !!p && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && !(p[0] === 0 && p[1] === 0);

/** Great-circle destination (lat, lon) from a start point, compass bearing (deg) and distance (km). */
export function destination(lat: number, lon: number, bearingDeg: number, km: number): [number, number] {
  const d = km / 6371.0088;
  const b = bearingDeg * RAD;
  const p1 = lat * RAD;
  const l1 = lon * RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / RAD, l2 / RAD];
}

function arrowIcon(bearing: number, color: string, size = 14) {
  return L.divIcon({
    className: "aegis-arrow",
    html: `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;transform:rotate(${bearing}deg);color:${color};font-size:${size}px;line-height:1;text-shadow:0 0 2px #0D1117,0 0 3px #0D1117;">▲</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Arrows point in the direction the air/water moves TOWARD (compass). */
function vectorLayer(vectors: GridVector[], color: string, kmPerMs: number, kind: string, pane: string): L.LayerGroup {
  const g = L.layerGroup();
  for (const v of vectors) {
    if (!Number.isFinite(v.speed_ms) || v.speed_ms <= 0 || !validLatLon([v.lat, v.lon])) continue;
    const tip = destination(v.lat, v.lon, v.direction_to_deg, v.speed_ms * kmPerMs);
    const html = `<div class="font-mono"><b>${kind}</b> ${v.speed_ms.toFixed(2)} m/s (${(v.speed_ms * 1.943844).toFixed(1)} kn)<br/>from ${v.direction_from_deg.toFixed(0)}° · toward ${v.direction_to_deg.toFixed(0)}°<br/>u=${v.u.toFixed(3)} v=${v.v.toFixed(3)} m/s<br/>${fmtLat(v.lat, 2)}, ${fmtLon(v.lon, 2)} · <span style="color:${statusColor(v.status)}">${v.status}</span></div>`;
    g.addLayer(L.polyline([[v.lat, v.lon], tip], { color, weight: 2.5, opacity: 0.95, pane }).bindTooltip(html, { sticky: true, className: "leaflet-dark-tooltip" }));
    g.addLayer(L.marker(tip, { icon: arrowIcon(v.direction_to_deg, color), interactive: false, pane }));
    g.addLayer(L.circleMarker([v.lat, v.lon], { radius: 2.5, color, fillColor: color, fillOpacity: 1, weight: 1, pane }));
  }
  return g;
}

export const GisMap: React.FC<GisMapProps> = ({
  scene, detection, drift, forward, environment, attribution, selectedVessel, onSelectVessel, onDownloadReport, reportEnabled, reportDisabledReason,
  focusMode = false, onToggleFocus,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groupsRef = useRef<Partial<Record<LayerKey, L.LayerGroup>>>({});
  const fitKeyRef = useRef<string>("");
  const boundsRef = useRef<Partial<Record<LayerKey, L.LatLngTuple[]>>>({});
  const tileRef = useRef<L.TileLayer | null>(null);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({
    sar: true, spill: true, reference: false, backtrack: true, origin: true, forecast: true, wind: true, current: true, ais: true,
  });
  const [horizon, setHorizon] = useState<number | "ALL">("ALL");
  const [legendOpen, setLegendOpen] = useState(focusMode);
  const [layersOpen, setLayersOpen] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [basemap, setBasemap] = useState<{ mode: "proxy" | "public"; tiles: string } | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // ------------------------------------------------------------ init once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { center: [28.9, -89.0], zoom: 10, zoomControl: false });
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomright", imperial: false }).addTo(map);
    const panes: [string, number][] = [["sar-pane", 400], ["forecast-pane", 590], ["vessel-pane", 600], ["drift-pane", 620], ["env-pane", 650], ["backtrack-pane", 680], ["spill-pane", 700]];
    for (const [name, z] of panes) {
      map.createPane(name);
      map.getPane(name)!.style.zIndex = String(z);
    }
    mapRef.current = map;
    setMapReady(true);
    return () => {
      try { map.remove(); } catch { /* ignore */ }
      mapRef.current = null;
      groupsRef.current = {};
      tileRef.current = null;
    };
  }, []);

  // ------------------------------------------------------------ basemap (CARTO key stays on the server)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/basemap").then((r) => r.json()).then((d) => { if (!cancelled) setBasemap({ mode: d.mode, tiles: d.tiles }); })
      .catch(() => { if (!cancelled) setBasemap({ mode: "public", tiles: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" }); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !basemap) return;
    if (tileRef.current) { map.removeLayer(tileRef.current); tileRef.current = null; }
    tileRef.current = L.tileLayer(basemap.tiles, {
      maxZoom: 19,
      subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
    tileRef.current.bringToBack();
  }, [basemap, mapReady]);

  // ------------------------------------------------------------ keep the map correct when its container is resized (focus mode, panels)
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { try { mapRef.current?.invalidateSize(); } catch { /* ignore */ } });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { const t = setTimeout(() => { try { mapRef.current?.invalidateSize(); } catch { /* ignore */ } }, 250); return () => clearTimeout(t); }, [focusMode]);
  // the big focus map has room for the legend; the small dashboard map starts with it collapsed (still one click away)
  useEffect(() => { setLegendOpen(focusMode); }, [focusMode]);

  // ------------------------------------------------------------ build layers from data
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const g of Object.values(groupsRef.current)) if (g) map.removeLayer(g);
    const groups: Partial<Record<LayerKey, L.LayerGroup>> = {};
    const bounds: L.LatLngTuple[] = [];
    const lb: Partial<Record<LayerKey, L.LatLngTuple[]>> = {};
    const tipCls = { className: "leaflet-dark-tooltip" };

    if (scene) {
      const [minLon, minLat, maxLon, maxLat] = scene.bbox;
      const g = L.layerGroup();
      g.addLayer(L.rectangle([[minLat, minLon], [maxLat, maxLon]], { color: "#58A6FF", weight: 1.5, dashArray: "4, 4", fillOpacity: 0.03, pane: "sar-pane" })
        .bindTooltip(`SAR frame: ${scene.scene_id}<br/>${scene.satellite}${scene.synthetic ? "<br/><b>SYNTHETIC DEMO</b>" : ""}`, { sticky: true, ...tipCls }));
      groups.sar = g;
      lb.sar = [[minLat, minLon], [maxLat, maxLon]];
      bounds.push([minLat, minLon], [maxLat, maxLon]);
    }

    if (detection?.geometry?.has_detection) {
      const g = L.layerGroup();
      const geo = detection.geometry;
      const parts = (geo.parts && geo.parts.length ? geo.parts : [geo.coordinates]) as number[][][];
      const srcLabel = detection.geometry_source === "MODEL_PREDICTION" ? "MODEL_PREDICTION (frozen U-Net, vectorised)" : detection.geometry_source === "SYNTHETIC_DEMO" ? "SYNTHETIC" : String(detection.geometry_source);
      const all: L.LatLngTuple[] = [];
      parts.forEach((ring, i) => {
        const ll = ring.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        all.push(...ll);
        g.addLayer(L.polygon(ll, { color: "#FF4444", weight: i === 0 ? 2 : 1.2, fillColor: "#FF4444", fillOpacity: i === 0 ? 0.3 : 0.22, dashArray: "3, 3", pane: "spill-pane" }).bindPopup(
          `<div class="text-xs font-mono"><div style="color:#FF4444;font-weight:700">Predicted slick S1_${detection.spill_id}${parts.length > 1 ? ` · part ${i + 1}/${parts.length}` : ""}</div>
           Total area: ${fmt(geo.area_km2)} km² · Perimeter ${fmt(geo.perimeter_km, 1)} km<br/>Axis: ${fmt(geo.orientation_deg, 1)}° · Elongation ${fmt(geo.elongation ?? null)}<br/>
           Observation: ${utc(detection.detection_time)}<br/>Outline: <span style="color:${statusColor(detection.geometry_source)}">${srcLabel}</span><br/><i>A model prediction, not a confirmed oil footprint.</i></div>`));
      });
      if (validLatLon(geo.centroid)) {
        g.addLayer(L.circleMarker(geo.centroid, { radius: 5, color: "#fff", weight: 2, fillColor: "#FF4444", fillOpacity: 1, pane: "spill-pane" })
          .bindTooltip(`Slick centroid ${fmtLatLon(geo.centroid)}`, tipCls));
      }
      groups.spill = g;
      lb.spill = all;
      bounds.push(...all);
    }

    // Reference label: evaluation-only overlay (never a detection, never used by the physics)
    if (detection?.reference_label?.parts?.length) {
      const g = L.layerGroup();
      const all: L.LatLngTuple[] = [];
      for (const ring of detection.reference_label.parts) {
        const ll = ring.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        all.push(...ll);
        g.addLayer(L.polygon(ll, { color: "#e3b341", weight: 2, dashArray: "8, 5", fill: false, pane: "sar-pane" }).bindPopup(
          `<div class="text-xs font-mono"><div style="color:#e3b341;font-weight:700">REFERENCE_LABEL (evaluation only)</div>
           Labelled mask: ${fmt(detection.reference_label.area_km2)} km² · ${detection.reference_label.pixel_count} px<br/><i>Not a model prediction; not used for drift or attribution.</i></div>`));
      }
      groups.reference = g;
      lb.reference = all;
    }

    const engine = drift?.engine;
    if (drift) {
      const g = L.layerGroup();
      for (const track of drift.particle_trajectories ?? []) {
        const ll = track.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        if (ll.length >= 2) g.addLayer(L.polyline(ll, { color: "#79C0FF", weight: 1, opacity: 0.35, dashArray: "3, 5", pane: "drift-pane" }));
      }
      const path = (engine?.centroid_path ?? []).map((c) => [c.lat, c.lon] as L.LatLngTuple);
      if (path.length >= 2) {
        g.addLayer(L.polyline(path, { color: "#0D1117", weight: 8, opacity: 0.8, pane: "backtrack-pane" }));
        g.addLayer(L.polyline(path, { color: "#00D9FF", weight: 3.5, pane: "backtrack-pane" })
          .bindTooltip(`<div class="font-mono"><b>ENSEMBLE BACKTRACK</b><br/>Centroid of ${engine?.num_particles} particles<br/>T0 → T-${fmt(engine?.hours, 1)} h</div>`, { sticky: true, ...tipCls }));
        for (let i = 2; i < path.length - 1; i += 4) {
          const a = path[i], b = path[i + 1];
          const brg = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) / RAD + 360) % 360;
          g.addLayer(L.marker(a, { icon: arrowIcon(brg, "#00D9FF", 12), interactive: false, pane: "backtrack-pane" }));
        }
        bounds.push(...path);
        lb.backtrack = path;
      }
      groups.backtrack = g;
    }

    if (drift?.probable_origin) {
      const po = drift.probable_origin;
      const g = L.layerGroup();
      for (const sn of engine?.snapshots ?? []) {
        if (sn.hours === engine?.hours) continue;
        const ll = sn.hull.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        if (ll.length >= 4) g.addLayer(L.polygon(ll, { color: "#79C0FF", weight: 0.8, opacity: 0.4, fillOpacity: 0.03, pane: "backtrack-pane" })
          .bindTooltip(`Origin corridor T-${sn.hours} h · P90 ${fmt(sn.r90_km)} km`, { sticky: true, ...tipCls }));
      }
      const hull = po.uncertainty_polygon.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
      if (hull.length >= 4) {
        g.addLayer(L.polygon(hull, { color: "#79C0FF", weight: 2, dashArray: "5, 5", fillColor: "#79C0FF", fillOpacity: 0.12, pane: "backtrack-pane" }).bindPopup(
          `<div class="text-xs font-mono"><div style="color:#79C0FF;font-weight:700">Origin hypothesis region (P90 particle hull)</div>
           Centroid: ${fmtLatLon(po.centroid)}<br/>P90 radius: ${fmt(po.uncertainty_radius_km)} km<br/>Horizon: T-${fmt(drift.simulation_duration_hours, 1)} h (analyst-set)<br/>
           Wind: ${fmt(drift.environmental_parameters.wind_speed_knots, 1)} kn [${drift.environmental_parameters.wind_status ?? ""}]<br/>
           Current: ${drift.environmental_parameters.current_speed_knots === null ? "not available" : fmt(drift.environmental_parameters.current_speed_knots, 1) + " kn"}</div>`));
        bounds.push(...hull);
        lb.origin = hull;
      }
      if (validLatLon(po.centroid)) {
        lb.origin = [...(lb.origin ?? []), po.centroid as L.LatLngTuple];
        g.addLayer(L.circleMarker(po.centroid, { radius: 8, color: "#0D1117", weight: 3, fillColor: "#00D9FF", fillOpacity: 1, pane: "backtrack-pane" })
          .bindTooltip(`<div class="font-mono"><b>ORIGIN HYPOTHESIS</b><br/>${fmtLatLon(po.centroid)}</div>`, tipCls));
        if (detection?.geometry?.centroid && validLatLon(detection.geometry.centroid)) {
          g.addLayer(L.polyline([detection.geometry.centroid, po.centroid], { color: "#fff", weight: 1, opacity: 0.4, dashArray: "2, 6", pane: "backtrack-pane" }));
        }
      }
      groups.origin = g;
    }

    // Future Impact Zone: P90 hulls of the forward particle ensemble at each horizon
    if (forward?.snapshots?.length) {
      const g = L.layerGroup();
      const path = forward.centroid_path.map((c) => [c.lat, c.lon] as L.LatLngTuple);
      if (path.length >= 2) g.addLayer(L.polyline(path, { color: "#f0883e", weight: 2.5, dashArray: "6, 4", pane: "forecast-pane" })
        .bindTooltip("Forecast ensemble-centroid path", { sticky: true, ...tipCls }));
      const snaps = forward.snapshots.filter((s) => horizon === "ALL" || s.hours === horizon);
      const fb: L.LatLngTuple[] = [];
      for (const sn of [...snaps].reverse()) {
        const col = horizonColor(sn.hours);
        const unsupported = sn.forcing_support?.supported === false;
        const hull = sn.hull.map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        if (hull.length >= 4) {
          g.addLayer(L.polygon(hull, { color: col, weight: 1.8, dashArray: unsupported ? "4, 4" : undefined, fillColor: col, fillOpacity: (horizon === "ALL" ? 0.06 : 0.14) * (unsupported ? 0.6 : 1), pane: "forecast-pane" }).bindPopup(
            `<div class="text-xs font-mono"><div style="color:${col};font-weight:700">${unsupported ? "Persistence SCENARIO" : "Future Impact Zone"} T+${sn.hours} h</div>
             ${utc(sn.time)}<br/>Centroid ${fmtLatLon(sn.centroid)}<br/>P50 / P90 radius ${fmt(sn.r50_km)} / ${fmt(sn.r90_km)} km<br/>
             P90 envelope area ${fmt(sn.hull_area_km2, 1)} km²<br/>Displacement ${fmt(sn.displacement_km)} km toward ${fmt(sn.displacement_bearing_deg, 0)}°<br/>
             Forcing REAL: wind ${(sn.wind_real_fraction * 100).toFixed(0)} % · current ${(sn.current_real_fraction * 100).toFixed(0)} %<br/>
             ${unsupported ? `<span style="color:#f0883e">⚠ ${sn.forcing_support.reason}</span><br/>` : ""}<i>Hindcast-type transport envelope only (no weathering). Not an observation. Coastal exposure not assessed.</i></div>`));
          bounds.push(...hull);
          fb.push(...hull);
        }
        if (validLatLon(sn.centroid)) {
          g.addLayer(L.circleMarker(sn.centroid, { radius: 4, color: "#0D1117", weight: 1.5, fillColor: col, fillOpacity: 1, pane: "forecast-pane" })
            .bindTooltip(`T+${sn.hours} h centroid`, tipCls));
        }
        if (horizon !== "ALL") {
          for (const [lon, lat] of sn.particles) g.addLayer(L.circleMarker([lat, lon], { radius: 1.6, stroke: false, fillColor: col, fillOpacity: 0.55, pane: "forecast-pane", interactive: false }));
        }
      }
      groups.forecast = g;
      lb.forecast = fb;
    }

    if (environment) {
      groups.wind = vectorLayer(environment.wind_grid_at_observation ?? [], "#e3b341", 5, "ERA5 10 m wind", "env-pane");
      groups.current = vectorLayer(environment.current_grid_at_observation ?? [], "#56d4dd", 25, "Surface current", "env-pane");
    }

    if (attribution?.top_candidates?.length) {
      const g = L.layerGroup();
      const shown = attribution.top_candidates.filter((v, i) => i < 25 || v.mmsi === selectedVessel?.mmsi);
      for (const vessel of shown) {
        const sel = selectedVessel?.mmsi === vessel.mmsi;
        const high = vessel.priority_level === "HIGH PRIORITY CANDIDATE";
        const med = vessel.priority_level === "MEDIUM PRIORITY CANDIDATE";
        const color = sel ? "#AFF5B4" : high ? "#FF4444" : med ? "#d29922" : "#8B949E";
        const ll = vessel.track_coordinates.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([lon, lat]) => [lat, lon] as L.LatLngTuple);
        if (ll.length < 2) continue;
        const line = L.polyline(ll, { color, weight: sel ? 3.5 : high ? 2.2 : 1.3, opacity: sel ? 1 : high ? 0.85 : 0.5, dashArray: sel ? undefined : "3, 3", pane: "vessel-pane" });
        line.on("click", () => onSelectVessel(vessel));
        line.bindTooltip(`<div class="font-mono"><b>#${vessel.rank} ${vessel.vessel_name}</b> (MMSI ${vessel.mmsi})<br/>Score ${vessel.composite_score.toFixed(3)} · ${vessel.priority_level}</div>`, { sticky: true, ...tipCls });
        g.addLayer(line);
        if (validLatLon(vessel.metrics.cpa_coordinates)) {
          const m = L.circleMarker(vessel.metrics.cpa_coordinates, { radius: sel ? 7 : high ? 5 : 3.5, color, weight: 2, fillColor: sel ? color : "#161B22", fillOpacity: 0.9, pane: "vessel-pane" });
          m.on("click", () => onSelectVessel(vessel));
          m.bindPopup(`<div class="text-xs font-mono"><b>#${vessel.rank} ${vessel.vessel_name}</b><br/>MMSI ${vessel.mmsi} · ${vessel.vessel_type}<br/>
            Closest approach to slick: ${fmt(vessel.metrics.min_distance_to_slick_km ?? null)} km at ${utc(vessel.metrics.cpa_timestamp)}<br/>
            Δt vs SAR: ${fmt(vessel.metrics.time_delta_hours, 1)} h · SOG ${fmt(vessel.metrics.cpa_speed_knots, 1)} kn<br/>
            Composite: ${vessel.composite_score.toFixed(3)} (priority-candidate score, not proof)</div>`);
          g.addLayer(m);
        }
      }
      groups.ais = g;
      lb.ais = shown.flatMap((v) => v.track_coordinates.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])).map(([lon, lat]) => [lat, lon] as L.LatLngTuple));
    }

    for (const [k, g] of Object.entries(groups) as [LayerKey, L.LayerGroup][]) {
      if (visible[k]) g.addTo(map);
    }
    groupsRef.current = groups;
    boundsRef.current = lb;

    // Refit only when the underlying incident changes; never on vessel/horizon clicks.
    const fitKey = `${scene?.scene_id}|${detection?.spill_id}|${drift?.simulation_id}|${forward?.start_time}`;
    const finite = bounds.filter((b) => Number.isFinite(b[0]) && Number.isFinite(b[1]));
    if (fitKey !== fitKeyRef.current && finite.length) {
      fitKeyRef.current = fitKey;
      try { map.fitBounds(finite, { padding: [30, 30], maxZoom: 12 }); } catch { /* ignore */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, detection, drift, forward, environment, attribution, selectedVessel, horizon, onSelectVessel]);

  // ------------------------------------------------------------ visibility toggles only
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const [k, g] of Object.entries(groupsRef.current) as [LayerKey, L.LayerGroup][]) {
      if (!g) continue;
      const on = map.hasLayer(g);
      if (visible[k] && !on) g.addTo(map);
      if (!visible[k] && on) map.removeLayer(g);
    }
  }, [visible]);

  // ------------------------------------------------------------ focus selected vessel (never null island)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selectedVessel) return;
    if (validLatLon(selectedVessel.metrics.cpa_coordinates)) {
      try { map.flyTo(selectedVessel.metrics.cpa_coordinates, Math.max(map.getZoom(), 11), { duration: 1.0 }); } catch { /* ignore */ }
    }
  }, [selectedVessel]);

  const fitTo = (keys: LayerKey[]) => {
    const map = mapRef.current;
    if (!map) return;
    const pts = keys.flatMap((k) => boundsRef.current[k] ?? []).filter((b) => Number.isFinite(b[0]) && Number.isFinite(b[1]));
    if (!pts.length) return;
    try { map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 }); } catch { /* ignore */ }
  };
  const has = (k: LayerKey) => (boundsRef.current[k]?.length ?? 0) > 0;

  const resetZoom = () => {
    const map = mapRef.current;
    if (!map || !scene) return;
    const [minLon, minLat, maxLon, maxLat] = scene.bbox;
    try { map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [30, 30] }); } catch { /* ignore */ }
  };

  const at = environment?.at_observation;
  const horizons = forward?.snapshots.map((s) => s.hours) ?? [];
  const unsupportedHorizons = new Set((forward?.snapshots ?? []).filter((s) => s.forcing_support?.supported === false).map((s) => s.hours));

  // forecast timeline: step / play through the horizons (view state only; nothing is recomputed)
  const order: (number | "ALL")[] = ["ALL", ...horizons];
  const stepHorizon = (d: number) => setHorizon((h) => order[(Math.max(0, order.indexOf(h)) + d + order.length) % order.length]);
  useEffect(() => {
    if (!playing || horizons.length === 0) return;
    const t = setInterval(() => setHorizon((h) => { const i = Math.max(0, order.indexOf(h)); return order[(i + 1) % order.length]; }), 1600);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, horizons.join(",")]);

  const btn = "pointer-events-auto bg-[#161B22] hover:bg-[#21262D] border border-[#30363D] hover:border-[#58A6FF] rounded-[4px] px-2 py-1.5 shadow-lg cursor-pointer text-[10px] font-mono text-[#C9D1D9] flex items-center gap-1.5 disabled:opacity-35 disabled:cursor-not-allowed";

  return (
    <div className="relative w-full h-full bg-[#0D1117] overflow-hidden">
      <div ref={containerRef} data-testid="gis-map" className="w-full h-full z-0" />

      {/* ---- top: actions row, then layers / timeline */}
      <div className="absolute top-3 left-3 right-3 z-10 flex flex-col gap-2 pointer-events-none">
        <div className="flex flex-wrap items-center gap-2">
          {onToggleFocus && (
            <button onClick={onToggleFocus} data-testid="focus-map-button" aria-pressed={focusMode}
              className={`${btn} ${focusMode ? "!border-[#58A6FF] !text-[#79C0FF]" : ""}`}
              title={focusMode ? "Exit focus map and restore the dashboard (Esc)" : "Focus map: make the map the full-screen workspace (panels collapse into drawers)"}
              aria-label={focusMode ? "Exit focus map" : "Enter focus map"}>
              {focusMode ? <Minimize2 className="w-3.5 h-3.5 text-[#58A6FF]" /> : <Maximize2 className="w-3.5 h-3.5 text-[#58A6FF]" />}
              {focusMode ? "EXIT FOCUS" : "FOCUS MAP"}
            </button>
          )}
          <div className="pointer-events-auto bg-[#161B22] border border-[#30363D] rounded-[4px] shadow-lg flex items-center" role="group" aria-label="Fit map view">
            <span className="px-2 text-[9px] font-mono text-[#8B949E] uppercase hidden sm:inline">Fit</span>
            <button onClick={() => fitTo(["spill"])} disabled={!has("spill")} className="px-2 py-1.5 text-[10px] font-mono text-[#C9D1D9] hover:bg-[#21262D] disabled:opacity-35 flex items-center gap-1 cursor-pointer border-l border-[#30363D]" title="Fit to the slick" aria-label="Fit to spill"><Target className="w-3.5 h-3.5 text-[#FF4444]" />Spill</button>
            <button onClick={() => fitTo(["origin"])} disabled={!has("origin")} className="px-2 py-1.5 text-[10px] font-mono text-[#C9D1D9] hover:bg-[#21262D] disabled:opacity-35 flex items-center gap-1 cursor-pointer border-l border-[#30363D]" title="Fit to the origin zone" aria-label="Fit to origin"><Crosshair className="w-3.5 h-3.5 text-[#79C0FF]" />Origin</button>
            <button onClick={() => fitTo(["forecast"])} disabled={!has("forecast")} className="px-2 py-1.5 text-[10px] font-mono text-[#C9D1D9] hover:bg-[#21262D] disabled:opacity-35 flex items-center gap-1 cursor-pointer border-l border-[#30363D]" title="Fit to the forecast impact zones" aria-label="Fit to forecast"><Milestone className="w-3.5 h-3.5 text-[#f0883e]" />Forecast</button>
            <button onClick={() => fitTo(["spill", "origin", "backtrack", "forecast", "ais"])} className="px-2 py-1.5 text-[10px] font-mono text-[#C9D1D9] hover:bg-[#21262D] flex items-center gap-1 cursor-pointer border-l border-[#30363D] rounded-r-[4px]" title="Fit to all evidence (slick, backtrack, origin, forecast, AIS tracks)" aria-label="Fit to all evidence"><ScanSearch className="w-3.5 h-3.5 text-[#AFF5B4]" />All</button>
          </div>
          <button onClick={resetZoom} className={btn} title="Fit the SAR scene extent" aria-label="Fit scene extent"><Compass className="w-3.5 h-3.5 text-[#58A6FF]" />Scene</button>
          <button onClick={() => onDownloadReport({ horizon })} disabled={!reportEnabled} data-testid="report-button"
            className={`${btn} !text-[#AFF5B4] !border-[#238636] font-semibold`}
            title={reportEnabled ? "Download colour-coded PDF incident report" : reportDisabledReason ?? "Report not available"} aria-label="Download incident report">
            <Download className="w-3.5 h-3.5" /> REPORT
          </button>
        </div>

        <div className="flex flex-wrap items-start gap-2">
          <div className="pointer-events-auto bg-[#161B22] border border-[#30363D] rounded-[6px] p-1.5 shadow-xl text-xs max-w-full">
            <button onClick={() => setLayersOpen((o) => !o)} className="flex items-center gap-1.5 text-[10px] font-mono text-[#C9D1D9] cursor-pointer w-full" aria-expanded={layersOpen} aria-label="Toggle layer controls" title="Show or hide the layer controls">
              <Layers className="w-3.5 h-3.5 text-[#58A6FF]" /> Layers {layersOpen ? <ChevronUp className="w-3 h-3 ml-auto" /> : <ChevronDown className="w-3 h-3 ml-auto" />}
            </button>
            {layersOpen && (
              <div className="flex flex-wrap items-center gap-1 mt-1.5">
                {(Object.keys(LAYER_LABELS) as LayerKey[]).map((k) => (
                  <button key={k} data-testid={`layer-${k}`} aria-pressed={visible[k]} onClick={() => setVisible((v) => ({ ...v, [k]: !v[k] }))}
                    title={LAYER_HINTS[k]}
                    className="px-2 py-0.5 rounded-[3px] text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                    style={visible[k] ? { color: LAYER_COLORS[k], borderColor: LAYER_COLORS[k] + "66", background: LAYER_COLORS[k] + "22" } : { color: "#8B949E", borderColor: "#30363D", background: "#0D1117" }}>
                    {visible[k] ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}{LAYER_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
          </div>

          {horizons.length > 0 && (
            <div className="pointer-events-auto bg-[#161B22] border border-[#30363D] rounded-[6px] p-1.5 shadow-xl flex flex-wrap items-center gap-1" role="group" aria-label="Forecast timeline">
              <span className="text-[9px] font-mono text-[#8B949E] mr-1 uppercase" title="Forward drift impact zone per horizon. A dashed zone is a persistence scenario: forcing coverage does not support a forecast.">Impact zone</span>
              <button onClick={() => stepHorizon(-1)} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer" title="Previous horizon" aria-label="Previous horizon"><SkipBack className="w-3.5 h-3.5" /></button>
              <button onClick={() => setPlaying((p) => !p)} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer" title={playing ? "Pause the horizon animation" : "Play through the horizons (view only)"} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}</button>
              <button onClick={() => stepHorizon(1)} className="text-[#8B949E] hover:text-[#C9D1D9] cursor-pointer" title="Next horizon" aria-label="Next horizon"><SkipForward className="w-3.5 h-3.5" /></button>
              {(["ALL", ...horizons] as (number | "ALL")[]).map((h) => (
                <button key={String(h)} data-testid={`horizon-${h}`} aria-pressed={horizon === h} onClick={() => { setPlaying(false); setHorizon(h); }}
                  title={h !== "ALL" && unsupportedHorizons.has(h as number) ? "Persistence scenario: real forcing coverage does not support this horizon as a forecast" : undefined}
                  className="px-1.5 py-0.5 rounded-[3px] text-[10px] font-mono border cursor-pointer flex items-center gap-0.5"
                  style={horizon === h ? { color: h === "ALL" ? "#C9D1D9" : horizonColor(h as number), borderColor: h === "ALL" ? "#8B949E" : horizonColor(h as number), background: "#21262D" } : { color: "#8B949E", borderColor: "#30363D" }}>
                  {h === "ALL" ? "All" : `T+${h}h`}{h !== "ALL" && unsupportedHorizons.has(h as number) && <TriangleAlert className="w-2.5 h-2.5 text-[#f0883e]" aria-label="not supported by forcing" />}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-2 font-mono">
          {drift?.engine && (
            <div className="bg-[#161B22]/95 border border-[#00D9FF]/50 rounded-[5px] px-2.5 py-1.5 shadow-xl">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold text-[#00D9FF]"><Route className="w-3.5 h-3.5" /> BACKTRACK T-{fmt(drift.engine.hours, 0)} h</div>
              <div className="text-[9px] text-[#8B949E]">{drift.engine.num_particles} particles · P90 {fmt(drift.engine.final.r90_km, 1)} km · seed {drift.engine.seed}</div>
            </div>
          )}
          {at && (
            <div data-testid="env-badge" className="bg-[#161B22]/95 border border-[#30363D] rounded-[5px] px-2.5 py-1.5 shadow-xl text-[9px]">
              <div className="flex items-center gap-1.5 text-[#e3b341]"><Wind className="w-3 h-3" /> {fmt(at.wind_speed_ms)} m/s from {fmt(at.wind_direction_from_deg, 0)}° <span style={{ color: statusColor(at.wind_status) }}>[{at.wind_status}]</span></div>
              <div className="flex items-center gap-1.5 text-[#56d4dd]"><Waves className="w-3 h-3" /> {at.current_speed_ms === null ? "Current: NOT ASSESSED (no product)" : `${fmt(at.current_speed_ms)} m/s toward ${fmt(at.current_direction_to_deg, 0)}°`} <span style={{ color: statusColor(at.current_status) }}>[{at.current_status}]</span></div>
              {environment?.low_wind_lookalike_risk && <div className="text-[#d29922]">⚠ low wind: look-alike risk</div>}
            </div>
          )}
        </div>
      </div>

      {/* ---- legend (collapsible) */}
      <div className="absolute bottom-3 left-3 z-10 bg-[#161B22] border border-[#30363D] rounded-[6px] p-2 shadow-xl text-[10px] text-[#8B949E] max-w-[19rem] font-mono" data-testid="map-legend">
        <button onClick={() => setLegendOpen((o) => !o)} className="w-full font-semibold text-[#C9D1D9] flex items-center justify-between cursor-pointer" aria-expanded={legendOpen} aria-label="Toggle legend">
          <span className="flex items-center gap-1.5"><Info className="w-3.5 h-3.5 text-[#58A6FF]" /> Legend <span className="text-[9px] text-[#8B949E] font-normal">WGS84</span></span>
          {legendOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        {legendOpen && (
          <div className="mt-1.5 space-y-1.5">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-[#FF4444] inline-block" />Slick (model prediction)</span>
              <span className="flex items-center gap-1.5"><span className="w-3 inline-block border-t-2 border-dashed border-[#e3b341]" />Reference label (eval only)</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-[#00D9FF] inline-block" />Backtrack</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 bg-[#79C0FF]/60 inline-block" />Origin zone (P90)</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-[#e3b341] inline-block" />Wind (5 km per m/s)</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-[#56d4dd] inline-block" />Current (25 km per m/s)</span>
              {[6, 12, 24, 48].map((h) => <span key={h} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 inline-block" style={{ background: horizonColor(h) }} />Impact T+{h}h</span>)}
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-[#FF4444] inline-block" />High-priority AIS lead</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-0.5 bg-[#AFF5B4] inline-block" />Selected AIS</span>
            </div>
            <div className="text-[9px] leading-snug border-t border-[#30363D] pt-1">Dashed impact zone = persistence scenario (real forcing coverage does not support a forecast). AIS tracks are investigative leads, not proof of causation.</div>
            {selectedVessel && (
              <div className="pt-1.5 border-t border-[#30363D] flex items-center justify-between text-[#AFF5B4]">
                <span className="truncate max-w-[150px]">Focus: {selectedVessel.vessel_name}</span>
                <button onClick={() => onSelectVessel(null)} className="text-[#8B949E] hover:text-[#C9D1D9] text-[9px] underline ml-2 cursor-pointer">[clear]</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
