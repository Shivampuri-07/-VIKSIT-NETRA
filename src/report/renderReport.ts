/**
 * Renders a ReportModel into PDF bytes with the dependency-free writer.
 * Handles pagination (tables repeat their header), text wrapping, missing
 * data (grey "not available" + NOT AVAILABLE chip) and missing images.
 */

import { PdfDoc, RGB, wrapText, measureText, fitText, FontStyle } from "./pdfWriter";
import type { ReportModel, Row } from "./reportModel";
import { fractionsText } from "./reportModel";
import {
  PROVENANCE, provenanceCategory, RISK, EVIDENCE, UNCERTAINTY, URGENCY, NODE_STATUS, CALLOUT, MAP,
  horizonRGB, evidenceBar, INK, MUTED, RULE, PANEL, BRAND, ChipStyle, hedged,
} from "./palette";
import { fmt, fmtLatLon, fmtLat, fmtLon, utc } from "../lib/format";

const LM = 14, RM = 196, CW = RM - LM, TOP = 22, BOTTOM = 279;
const PT = 0.3528; // mm per point

type Cell =
  | string | null | undefined
  | { text?: string | null; chip?: { label: string; style: ChipStyle } | null; bar?: { value: number; hollow?: boolean } | null;
      bold?: boolean; italic?: boolean; color?: RGB; align?: "left" | "right" | "center" };
interface Col { title: string; w: number; align?: "left" | "right" | "center" }

function provChip(status?: string | null) {
  const c = provenanceCategory(status);
  return { label: c, style: PROVENANCE[c] };
}

class Writer {
  y = TOP;
  constructor(readonly doc: PdfDoc, readonly m: ReportModel) {}

  // ----------------------------------------------------------------- pages
  newPage() {
    this.doc.addPage();
    const d = this.doc;
    d.rect(0, 0, 210, 12, { fill: BRAND });
    d.text("AEGIS  |  OIL-SPILL INCIDENT INTELLIGENCE REPORT", LM, 7.8, { font: "bold", size: 8.5, color: [255, 255, 255] });
    d.text(fitText(this.m.incidentId, 80, "regular", 7.5), RM, 7.8, { size: 7.5, color: [201, 209, 217], align: "right" });
    if (this.m.synthetic) {
      d.rect(0, 12, 210, 5, { fill: PROVENANCE["FALLBACK/DEMO"].fill });
      d.text("SYNTHETIC DEMO DATA - NOT A REAL EVENT", 105, 15.6, { font: "bold", size: 7, color: [255, 255, 255], align: "center" });
    }
    this.y = TOP;
  }

  ensure(h: number) {
    if (this.y + h > BOTTOM) this.newPage();
  }

  lh(size: number) { return size * PT * 1.32; }

  // ----------------------------------------------------------------- primitives
  chip(x: number, yTop: number, label: string, style: ChipStyle, size = 6.3): number {
    const w = measureText(label, "bold", size) + 3;
    if (style.outline) {
      // hedged: white fill + coloured border (associated uncertainty is HIGH)
      this.doc.rect(x, yTop, w, 3.9, { fill: [255, 255, 255], stroke: style.fill, lineWidth: 0.35 });
      this.doc.text(label, x + 1.5, yTop + 2.85, { font: "bold", size, color: INK });
    } else {
      this.doc.rect(x, yTop, w, 3.9, { fill: style.fill, stroke: style.fill === PANEL ? RULE : null, lineWidth: 0.15 });
      this.doc.text(label, x + 1.5, yTop + 2.85, { font: "bold", size, color: style.text });
    }
    return w;
  }

  bar(x: number, yTop: number, w: number, value: number, hollow = false) {
    const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    const col = evidenceBar(v);
    this.doc.rect(x, yTop, w, 2.6, { fill: [234, 238, 242] });
    if (v > 0) this.doc.rect(x, yTop, w * v, 2.6, hollow ? { stroke: col, lineWidth: 0.35, fill: null } : { fill: col });
  }

  heading(num: string, title: string) {
    this.ensure(34); // keep the heading with at least a few lines of its content
    this.y += 3;
    this.doc.rect(LM, this.y, 1.4, 6, { fill: BRAND });
    this.doc.text(`${num}  ${title}`, LM + 3.5, this.y + 4.8, { font: "bold", size: 12.5, color: INK });
    this.y += 8;
    this.doc.line(LM, this.y, RM, this.y, { stroke: RULE, lineWidth: 0.3 });
    this.y += 3;
  }

  sub(title: string, chips: { label: string; style: ChipStyle }[] = []) {
    this.ensure(10);
    this.y += 1.5;
    const w = this.doc.text(fitText(title, CW - chips.length * 30, "bold", 9.5), LM, this.y + 3.5, { font: "bold", size: 9.5, color: INK });
    let x = LM + w + 3;
    for (const c of chips) x += this.chip(x, this.y + 0.6, c.label, c.style) + 1.5;
    this.y += 6;
  }

  para(text: string, o: { size?: number; font?: FontStyle; color?: RGB; indent?: number; width?: number } = {}) {
    const size = o.size ?? 8.2;
    const font = o.font ?? "regular";
    const indent = o.indent ?? 0;
    const lh = this.lh(size);
    for (const line of wrapText(text, (o.width ?? CW) - indent, font, size)) {
      this.ensure(lh);
      this.doc.text(line, LM + indent, this.y + lh * 0.78, { font, size, color: o.color ?? INK });
      this.y += lh;
    }
  }

  bullets(items: string[], o: { prefix?: string; color?: RGB; size?: number; indent?: number } = {}) {
    const size = o.size ?? 8;
    const lh = this.lh(size);
    const ind = o.indent ?? 0;
    for (const it of items) {
      const lines = wrapText(it, CW - 5 - ind, "regular", size);
      lines.forEach((line, i) => {
        this.ensure(lh);
        if (i === 0) this.doc.text(o.prefix ?? "-", LM + ind + 1, this.y + lh * 0.78, { font: "bold", size, color: o.color ?? MUTED });
        this.doc.text(line, LM + ind + 5, this.y + lh * 0.78, { size, color: INK });
        this.y += lh;
      });
    }
  }

  callout(kind: keyof typeof CALLOUT, title: string, lines: string[], size = 7.8) {
    const st = CALLOUT[kind];
    const lh = this.lh(size);
    const wrapped = lines.flatMap((l) => wrapText(l, CW - 8, "regular", size));
    const total = 7 + wrapped.length * lh + 2.5;
    if (total > BOTTOM - TOP - 5) {
      // too long for one box: title bar + flowing text
      this.ensure(12);
      this.doc.rect(LM, this.y, CW, 6, { fill: st.bg, stroke: st.border, lineWidth: 0.4 });
      this.doc.text(title, LM + 3, this.y + 4.2, { font: "bold", size: 8.5, color: st.title });
      this.y += 8;
      for (const l of lines) this.para(l, { size, indent: 3 });
      this.y += 2;
      return;
    }
    this.ensure(total);
    this.doc.rect(LM, this.y, CW, total, { fill: st.bg, stroke: st.border, lineWidth: 0.45 });
    this.doc.rect(LM, this.y, 1.6, total, { fill: st.border });
    this.doc.text(title, LM + 4, this.y + 4.6, { font: "bold", size: 8.5, color: st.title });
    let yy = this.y + 7 + lh * 0.78;
    for (const l of wrapped) { this.doc.text(l, LM + 4, yy, { size, color: INK }); yy += lh; }
    this.y += total + 3;
  }

  /** Generic table with wrapping cells, repeated header and page breaks. */
  table(cols: Col[], rows: Cell[][], o: { size?: number; rowFill?: (i: number) => RGB | null; maxLines?: number } = {}) {
    const size = o.size ?? 7;
    const lh = this.lh(size);
    const pad = 1.1;
    const hdrH = lh + 2 * pad;
    const drawHeader = () => {
      this.doc.rect(LM, this.y, CW, hdrH, { fill: [230, 234, 239] });
      let x = LM;
      for (const c of cols) {
        const t = fitText(c.title, c.w - 2 * pad, "bold", size);
        const tx = c.align === "right" ? x + c.w - pad : c.align === "center" ? x + c.w / 2 : x + pad;
        this.doc.text(t, tx, this.y + pad + lh * 0.78, { font: "bold", size, color: INK, align: c.align ?? "left" });
        x += c.w;
      }
      this.y += hdrH;
    };
    this.ensure(hdrH + lh + 2 * pad);
    drawHeader();
    rows.forEach((row, ri) => {
      const layouts = cols.map((c, ci) => {
        const cell = row[ci];
        const obj = cell && typeof cell === "object" ? cell : { text: cell as string | null | undefined };
        const font: FontStyle = obj.bold ? "bold" : obj.italic ? "italic" : "regular";
        const isNA = obj.text === null || (obj.text === undefined && !obj.chip && !obj.bar);
        const chipH = obj.chip ? 4.4 : 0;
        const barH = obj.bar ? 3.4 : 0;
        let lines = isNA ? ["not available"] : obj.text ? wrapText(obj.text, c.w - 2 * pad, font, size) : [];
        const maxL = o.maxLines ?? 14;
        if (lines.length > maxL) lines = [...lines.slice(0, maxL - 1), fitText(lines[maxL - 1] + " ...", c.w - 2 * pad, font, size)];
        return { obj, font, isNA, lines, h: chipH + barH + lines.length * lh };
      });
      const rowH = Math.max(lh, ...layouts.map((l) => l.h)) + 2 * pad;
      if (this.y + rowH > BOTTOM) { this.newPage(); drawHeader(); }
      const fill = o.rowFill?.(ri) ?? (ri % 2 ? PANEL : null);
      if (fill) this.doc.rect(LM, this.y, CW, rowH, { fill });
      let x = LM;
      layouts.forEach((L, ci) => {
        const c = cols[ci];
        let yy = this.y + pad;
        if (L.obj.chip) { this.chip(x + pad, yy, L.obj.chip.label, L.obj.chip.style); yy += 4.4; }
        if (L.obj.bar) { this.bar(x + pad, yy + 0.2, c.w - 2 * pad, L.obj.bar.value, L.obj.bar.hollow); yy += 3.4; }
        const align = L.obj.align ?? c.align ?? "left";
        const tx = align === "right" ? x + c.w - pad : align === "center" ? x + c.w / 2 : x + pad;
        for (const line of L.lines) {
          this.doc.text(line, tx, yy + lh * 0.78, { font: L.isNA ? "italic" : L.font, size, color: L.isNA ? MUTED : L.obj.color ?? INK, align });
          yy += lh;
        }
        x += c.w;
      });
      this.y += rowH;
      this.doc.line(LM, this.y, RM, this.y, { stroke: RULE, lineWidth: 0.12 });
    });
    this.y += 2.5;
  }

  kv(rows: Row[], labelW = 50, size = 7.6) {
    this.table(
      [{ title: "Item", w: labelW }, { title: "Value", w: CW - labelW }],
      rows.map((r) => [
        { text: r.label, bold: true },
        {
          text: r.value === null ? null : r.value + (r.note ? `\n${r.note}` : ""),
          chip: r.chip
            ? { label: `${r.chip.dim === "risk" ? "RISK" : "UNCERTAINTY"} ${r.chip.level}`, style: (r.chip.dim === "risk" ? RISK[r.chip.level] ?? RISK.UNKNOWN : UNCERTAINTY[r.chip.level] ?? UNCERTAINTY["N/A"]) }
            : r.status ? provChip(r.status) : null,
        },
      ]),
      { size },
    );
  }
}

// ---------------------------------------------------------------------------
// situation map
// ---------------------------------------------------------------------------

function niceStep(span: number): number {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];
  return steps.find((s) => span / s <= 5) ?? 5;
}

function drawMap(w: Writer, m: ReportModel) {
  const doc = w.doc;
  const det = m.detection;
  const bw = m.backward;
  const fw = m.forward;
  const shownSnaps = (fw?.snapshots ?? []).filter((s) => m.horizon === "ALL" || s.hours === m.horizon);
  const pts: [number, number][] = [];
  for (const p of det?.geometry.coordinates ?? []) pts.push([p[0], p[1]]);
  for (const p of bw?.final.hull ?? []) pts.push([p[0], p[1]]);
  for (const c of bw?.centroid_path ?? []) pts.push([c.lon, c.lat]);
  for (const s of shownSnaps) for (const p of s.hull) pts.push([p[0], p[1]]);
  const valid = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1]) <= 90);
  if (!valid.length) {
    w.callout("unavailable", "Situation map not available", ["No spill, origin or forecast geometry was produced by this investigation."]);
    return;
  }
  let lonMin = Math.min(...valid.map((p) => p[0])), lonMax = Math.max(...valid.map((p) => p[0]));
  let latMin = Math.min(...valid.map((p) => p[1])), latMax = Math.max(...valid.map((p) => p[1]));
  const lat0 = (latMin + latMax) / 2;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const padLat = Math.max(0.01, (latMax - latMin) * 0.12), padLon = Math.max(0.01 / kx, (lonMax - lonMin) * 0.12);
  lonMin -= padLon; lonMax += padLon; latMin -= padLat; latMax += padLat;

  const boxW = CW, boxH = 118;
  w.ensure(boxH + 26);
  const x0 = LM, y0 = w.y;
  const spanX = (lonMax - lonMin) * kx, spanY = latMax - latMin;
  const s = Math.min(boxW / spanX, boxH / spanY); // mm per degree-lat
  const ox = x0 + (boxW - spanX * s) / 2, oy = y0 + (boxH - spanY * s) / 2;
  const P = (lon: number, lat: number): [number, number] => [ox + (lon - lonMin) * kx * s, oy + (latMax - lat) * s];

  doc.rect(x0, y0, boxW, boxH, { fill: MAP.sea });
  doc.clip(x0, y0, boxW, boxH, () => {
    // graticule
    const stepLat = niceStep(spanY), stepLon = niceStep(lonMax - lonMin);
    for (let la = Math.ceil(latMin / stepLat) * stepLat; la <= latMax; la += stepLat) {
      const [, yy] = P(lonMin, la);
      doc.line(x0, yy, x0 + boxW, yy, { stroke: MAP.grid, lineWidth: 0.15 });
      doc.text(fmtLat(la, stepLat < 0.1 ? 2 : 1), x0 + 1, yy - 0.6, { size: 5.5, color: MUTED });
    }
    for (let lo = Math.ceil(lonMin / stepLon) * stepLon; lo <= lonMax; lo += stepLon) {
      const [xx] = P(lo, latMin);
      doc.line(xx, y0, xx, y0 + boxH, { stroke: MAP.grid, lineWidth: 0.15 });
      doc.text(fmtLon(lo, stepLon < 0.1 ? 2 : 1), xx + 0.6, y0 + boxH - 1, { size: 5.5, color: MUTED });
    }
    // forecast envelopes, largest first
    for (const sn of [...shownSnaps].sort((a, b) => b.hours - a.hours)) {
      const c = horizonRGB(sn.hours);
      doc.polygon(sn.hull.map((p) => P(p[0], p[1])), { fill: c, fillOpacity: shownSnaps.length > 1 ? 0.1 : 0.16, stroke: c, lineWidth: 0.35 });
      if (shownSnaps.length === 1) for (const p of sn.particles) { const [xx, yy] = P(p[0], p[1]); doc.circle(xx, yy, 0.28, { fill: c, fillOpacity: 0.55 }); }
    }
    if (fw && fw.centroid_path.length > 1) doc.polyline(fw.centroid_path.map((c) => P(c.lon, c.lat)), { stroke: horizonRGB(48), lineWidth: 0.35, dash: [1.2, 0.8] });
    // origin corridor + backtrack path
    if (bw) {
      for (const sn of bw.snapshots) if (sn.hours !== bw.hours) doc.polygon(sn.hull.map((p) => P(p[0], p[1])), { stroke: MAP.origin, lineWidth: 0.15, strokeOpacity: 0.45, dash: [0.6, 0.6] });
      doc.polygon(bw.final.hull.map((p) => P(p[0], p[1])), { fill: MAP.origin, fillOpacity: 0.1, stroke: MAP.origin, lineWidth: 0.45, dash: [1.5, 1] });
      doc.polyline(bw.centroid_path.map((c) => P(c.lon, c.lat)), { stroke: MAP.origin, lineWidth: 0.6 });
    }
    // vessel tracks: top 10 + selected
    const cands = m.attribution?.candidates ?? [];
    const shownV = cands.filter((c, i) => i < 10 || c.mmsi === m.selectedVessel?.mmsi);
    for (const v of [...shownV].reverse()) {
      const sel = v.mmsi === m.selectedVessel?.mmsi;
      const topN = v.rank <= 3;
      doc.polyline(v.track_coordinates.map((p) => P(p[0], p[1])), { stroke: sel ? MAP.selected : topN ? MAP.vesselTop : MAP.vessel, lineWidth: sel ? 0.55 : topN ? 0.35 : 0.18, strokeOpacity: sel || topN ? 1 : 0.6 });
    }
    for (const v of shownV.filter((c) => c.rank <= 3 || c.mmsi === m.selectedVessel?.mmsi)) {
      const [la, lo] = v.metrics.cpa_coordinates;
      if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) continue;
      const [xx, yy] = P(lo, la);
      doc.circle(xx, yy, 0.8, { fill: [255, 255, 255], stroke: v.mmsi === m.selectedVessel?.mmsi ? MAP.selected : MAP.vesselTop, lineWidth: 0.3 });
      doc.text(`#${v.rank}`, xx + 1.2, yy - 0.8, { font: "bold", size: 5.5, color: v.mmsi === m.selectedVessel?.mmsi ? MAP.selected : MAP.vesselTop });
    }
    // slick
    if (det) {
      doc.polygon(det.geometry.coordinates.map((p) => P(p[0], p[1])), { fill: MAP.slick, fillOpacity: 0.55, stroke: MAP.slick, lineWidth: 0.35 });
      const [cx, cy] = P(det.geometry.centroid[1], det.geometry.centroid[0]);
      doc.circle(cx, cy, 0.7, { fill: [255, 255, 255], stroke: MAP.slick, lineWidth: 0.3 });
    }
    if (bw) {
      const [ox2, oy2] = P(bw.final.centroid[1], bw.final.centroid[0]);
      doc.circle(ox2, oy2, 1, { fill: MAP.origin, stroke: [255, 255, 255], lineWidth: 0.3 });
      doc.text("origin", ox2 + 1.4, oy2 + 2.2, { size: 5.5, color: MAP.origin, font: "bold" });
    }
    for (const sn of shownSnaps) {
      const [xx, yy] = P(sn.centroid[1], sn.centroid[0]);
      doc.circle(xx, yy, 0.8, { fill: horizonRGB(sn.hours), stroke: [255, 255, 255], lineWidth: 0.25 });
      doc.text(`T+${sn.hours}h`, xx + 1.2, yy + 2.2, { size: 5.5, font: "bold", color: horizonRGB(sn.hours) });
    }
    // wind (and current) vectors at native grid points: arrow length proportional to speed
    const vecs = [
      ...(m.environment?.windGrid ?? []).map((v) => ({ v, col: MAP.wind })),
    ];
    const maxSpeed = Math.max(0.01, ...vecs.map((x) => x.v.speed_ms));
    for (const { v, col } of vecs) {
      const [xx, yy] = P(v.lon, v.lat);
      const len = (v.speed_ms / maxSpeed) * 10;
      const a = (v.direction_to_deg * Math.PI) / 180;
      const ex = xx + Math.sin(a) * len, ey = yy - Math.cos(a) * len;
      doc.line(xx, yy, ex, ey, { stroke: col, lineWidth: 0.5 });
      const hw = 1.1, hl = 1.8;
      doc.polygon([[ex, ey], [ex - Math.sin(a) * hl + Math.cos(a) * hw, ey + Math.cos(a) * hl + Math.sin(a) * hw], [ex - Math.sin(a) * hl - Math.cos(a) * hw, ey + Math.cos(a) * hl - Math.sin(a) * hw]], { fill: col });
      doc.circle(xx, yy, 0.45, { fill: col });
      doc.text(`${v.speed_ms.toFixed(1)} m/s`, xx + 1, yy + 2.4, { size: 5, color: col });
    }
  });
  doc.rect(x0, y0, boxW, boxH, { stroke: INK, lineWidth: 0.3 });
  // north arrow
  const nx = x0 + boxW - 7, ny = y0 + 4;
  doc.polygon([[nx, ny], [nx - 2, ny + 6], [nx, ny + 4.6], [nx + 2, ny + 6]], { fill: INK });
  doc.text("N", nx, ny + 9.5, { font: "bold", size: 7, color: INK, align: "center" });
  // scale bar
  const mmPerKm = s / 111.195;
  const targetKm = (boxW * 0.2) / mmPerKm;
  const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200].find((k) => k >= targetKm * 0.6) ?? 200;
  const sbW = nice * mmPerKm;
  const sbx = x0 + 4, sby = y0 + boxH - 6;
  doc.rect(sbx - 1, sby - 3.8, sbW + 12, 6, { fill: [255, 255, 255], fillOpacity: 0.8 });
  doc.rect(sbx, sby - 1.2, sbW / 2, 1.2, { fill: INK });
  doc.rect(sbx + sbW / 2, sby - 1.2, sbW / 2, 1.2, { fill: [255, 255, 255], stroke: INK, lineWidth: 0.2 });
  doc.text(`${nice} km`, sbx + sbW + 1.5, sby, { size: 6, color: INK });
  w.y = y0 + boxH + 2;

  // legend
  const items: { label: string; draw: (x: number, y: number) => void }[] = [
    { label: "Observed slick", draw: (x, y) => doc.rect(x, y - 2.2, 4, 2.6, { fill: MAP.slick, fillOpacity: 0.55, stroke: MAP.slick, lineWidth: 0.3 }) },
    { label: `Origin corridor P90 (T-${bw?.hours ?? "?"} h)`, draw: (x, y) => doc.rect(x, y - 2.2, 4, 2.6, { fill: MAP.origin, fillOpacity: 0.12, stroke: MAP.origin, lineWidth: 0.35, dash: [0.8, 0.5] }) },
    { label: "Backtrack centroid path", draw: (x, y) => doc.line(x, y - 0.9, x + 4, y - 0.9, { stroke: MAP.origin, lineWidth: 0.6 }) },
    ...shownSnaps.map((sn) => ({ label: `Impact zone T+${sn.hours} h (P90)`, draw: (x: number, y: number) => doc.rect(x, y - 2.2, 4, 2.6, { fill: horizonRGB(sn.hours), fillOpacity: 0.3, stroke: horizonRGB(sn.hours), lineWidth: 0.3 }) })),
    { label: "AIS track (#1-#3 bold)", draw: (x, y) => doc.line(x, y - 0.9, x + 4, y - 0.9, { stroke: MAP.vesselTop, lineWidth: 0.35 }) },
    ...(m.selectedVessel ? [{ label: `Selected: ${m.selectedVessel.vessel_name}`, draw: (x: number, y: number) => doc.line(x, y - 0.9, x + 4, y - 0.9, { stroke: MAP.selected, lineWidth: 0.55 }) }] : []),
    { label: "ERA5 wind at T0 (toward)", draw: (x, y) => doc.line(x, y - 0.9, x + 4, y - 0.9, { stroke: MAP.wind, lineWidth: 0.5 }) },
  ];
  let lx = LM, ly = w.y + 3;
  for (const it of items) {
    const tw = measureText(it.label, "regular", 6.5) + 9;
    if (lx + tw > RM) { lx = LM; ly += 4; }
    it.draw(lx, ly);
    doc.text(it.label, lx + 5, ly, { size: 6.5, color: INK });
    lx += tw;
  }
  w.y = ly + 3;
  w.para(
    `Schematic map drawn from the investigation geometry (WGS84, equirectangular at ${lat0.toFixed(2)} deg; not a navigational chart). ` +
      `Forecast horizon shown: ${m.horizon === "ALL" ? "all horizons" : `T+${m.horizon} h with its particle cloud`} (as selected in the viewer). ` +
      (m.environment && !m.environment.currentAvailable ? "No current vectors are drawn: no ocean-current product is available. " : "") +
      "Tracks are clipped to the map frame.",
    { size: 6.8, color: MUTED, font: "italic" },
  );
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

export function renderReport(m: ReportModel): { bytes: Uint8Array; pages: number } {
  const doc = new PdfDoc({ title: `AEGIS incident report ${m.incidentId}`, subject: "Oil-spill decision-support report (not legal evidence)", creationDate: new Date(m.generatedAt) });
  const w = new Writer(doc, m);
  w.newPage();

  // ---------------- cover
  doc.text("Oil-Spill Incident Intelligence Report", LM, w.y + 7, { font: "bold", size: 18, color: INK });
  w.y += 11;
  w.para(`${m.scene?.name ?? "Unknown scene"}  |  ${m.scene?.region ?? ""}`, { size: 10, color: MUTED });
  w.y += 1;
  w.kv([
    { label: "Incident ID", value: m.incidentId },
    { label: "Investigation", value: `${m.investigationId} (status: ${m.investigationStatus})` },
    { label: "Report generated", value: utc(m.generatedAt) },
    { label: "Viewer state", value: `forecast horizon ${m.horizon === "ALL" ? "ALL" : `T+${m.horizon} h`}; selected vessel ${m.selectedVessel ? `${m.selectedVessel.vessel_name} (MMSI ${m.selectedVessel.mmsi})` : "none"}; ranking weights spatial ${fmt(m.attribution?.weights_used.spatial ?? null)}, temporal ${fmt(m.attribution?.weights_used.temporal ?? null)}, corridor ${fmt(m.attribution?.weights_used.trajectory ?? null)}, kinematic ${fmt(m.attribution?.weights_used.consistency ?? null)}` },
  ], 38);
  w.callout("disclaimer", "NOT LEGAL PROOF", [m.disclaimers[0]]);
  if (m.synthetic) w.callout("demo", "SYNTHETIC DEMO SCENE", ["The SAR slick, environmental constants and AIS tracks of this scene are generated for interface demonstration. Vessel names are fictitious and marked [SYNTHETIC]. No statement in this report refers to a real vessel or event."]);
  if (m.missing.length) w.callout("unavailable", "Sections without data in this investigation", m.missing.map((x) => `${x}: not produced (see timeline).`));

  w.heading("", "Executive summary");
  w.kv(m.summary, 50);

  // ---------------- legend
  w.sub("How to read colours in this report");
  const legendRow = (title: string, chips: [string, ChipStyle][], note: string) => {
    w.ensure(9);
    doc.text(title, LM, w.y + 3, { font: "bold", size: 7.2, color: INK });
    let x = LM + 27;
    for (const [l, st] of chips) x += w.chip(x, w.y, l, st, 5.8) + 1.2;
    doc.text(fitText(note, RM - x - 2, "italic", 6.3), x + 1, w.y + 3, { font: "italic", size: 6.3, color: MUTED });
    w.y += 5.4;
  };
  legendRow("Data provenance", [["REAL", PROVENANCE.REAL], ["MODEL PREDICTION", PROVENANCE["MODEL PREDICTION"]], ["DERIVED GEOMETRY", PROVENANCE["DERIVED GEOMETRY"]], ["PERSISTED", PROVENANCE.PERSISTED], ["REFERENCE LABEL", PROVENANCE["REFERENCE LABEL"]], ["LAND/NO DATA", PROVENANCE["LAND/NO DATA"]], ["FALLBACK/DEMO", PROVENANCE["FALLBACK/DEMO"]], ["NOT AVAILABLE", PROVENANCE["NOT AVAILABLE"]]], "origin of each value");
  legendRow("Risk / urgency", [["LOW", RISK.LOW], ["MODERATE", RISK.MODERATE], ["HIGH", RISK.HIGH], ["SEVERE", RISK.SEVERE]], "only used for risk and action urgency");
  legendRow("Evidence strength", [["STRONG", EVIDENCE.STRONG], ["MODERATE", EVIDENCE.MODERATE], ["WEAK", EVIDENCE.WEAK], ["NONE", EVIDENCE.NONE]], "blue scale; not a probability");
  legendRow("Uncertainty", [["LOW", UNCERTAINTY.LOW], ["MEDIUM", UNCERTAINTY.MEDIUM], ["HIGH", UNCERTAINTY.HIGH]], "darker = MORE uncertain");
  w.para("Score bars and evidence/score chips are drawn hollow (outlined) when the associated uncertainty is HIGH, so a high score never looks like a confident result. Amber boxes are warnings; grey italic 'not available' marks data that does not exist for this incident. Forecast horizons on the map use a time ramp (teal to navy), not severity colours.", { size: 6.8, color: MUTED });

  // ---------------- 1 detection
  const det = m.detection;
  w.heading("1", "Satellite detection and SAR evidence");
  if (det) {
    w.kv([
      { label: "Satellite / source", value: `${m.scene?.satellite ?? "n/a"}, polarisation ${det.polarization}; ${det.data_source ?? ""}`, status: det.synthetic ? "SYNTHETIC_DEMO" : "REAL" },
      { label: "Detection timestamp (T0)", value: utc(det.detection_time) },
      { label: "Slick outline", value: det.geometry_source_detail ?? null, status: det.geometry_source ?? null },
      { label: "Segmentation model", value: det.ml_model ? `${det.ml_model.name}: ${det.ml_model.architecture ?? ""}; checkpoint ${det.ml_model.checkpoint ?? "?"} (epoch ${det.ml_model.checkpoint_epoch ?? "?"})` : null },
      { label: "Model run provenance", value: det.prediction_provenance ? `MODEL_PREDICTION: checkpoint sha256 ${String(det.prediction_provenance.model?.checkpoint_sha256 ?? "").slice(0, 12)}..., ${det.prediction_provenance.inference?.normalization ?? "?"}-normalised, ${det.prediction_provenance.inference?.tiling ?? ""}, threshold ${det.prediction_provenance.inference?.threshold ?? "?"}, device ${det.prediction_provenance.inference?.device ?? "?"}; source raster ${det.prediction_provenance.source_raster?.file ?? "?"} (${det.prediction_provenance.source_raster?.crs ?? "?"}, ${det.prediction_provenance.source_raster?.pixel_size_m ?? "?"} m)` : null, status: det.prediction_provenance ? "MODEL_PREDICTION" : null },
      { label: "Segmentation quality (MEASURED)", value: det.segmentation_quality && det.segmentation_quality.scene_dice_vs_label != null ? `${det.segmentation_quality.scene_metrics_provenance}: Dice ${fmt(det.segmentation_quality.scene_dice_vs_label, 3)}, IoU ${fmt(det.segmentation_quality.scene_iou_vs_label ?? null, 3)}, precision ${fmt(det.segmentation_quality.scene_precision_vs_label ?? null, 3)}, recall ${fmt(det.segmentation_quality.scene_recall_vs_label ?? null, 3)} vs the reference label of this scene; held-out test-set mean Dice ${fmt(det.segmentation_quality.fresh_test_set_mean_dice_scene_overlap_protocol ?? null, 3)} (7 scenes, scene-normalised full-coverage protocol; ${det.segmentation_quality.fresh_test_set_provenance}).` : "NOT_MEASURED for this scene" },
      { label: "Segmentation quality (STORED_HISTORICAL)", value: det.segmentation_quality ? `${det.segmentation_quality.stored_historical_provenance ?? "registry"}: this scene Dice ${fmt(det.segmentation_quality.stored_historical_scene_dice ?? det.segmentation_quality.scene_dice_vs_label ?? null, 3)}; test-set mean Dice ${fmt(det.segmentation_quality.fresh_test_set_mean_dice_historic_protocol ?? det.segmentation_quality.test_set_mean_dice ?? null, 3)}; validation Dice ${fmt(det.segmentation_quality.validation_dice ?? null, 3)} is optimistic (train and validation patches share the same 14 source scenes). Probabilities are not calibrated; no per-pixel confidence is reported.` : null },
      { label: "Reference label (evaluation only)", value: det.reference_label ? `REFERENCE_LABEL: ${fmt(det.reference_label.area_km2, 2)} km2, ${det.reference_label.pixel_count} px. Shown for evaluation; it is not a model prediction and is not used by drift, attribution or hypotheses.` : "not available for this scene", status: det.reference_label ? "REFERENCE_LABEL" : null },
    ], 42);
    const imgs = m.images.filter((i) => i.bytes);
    if (imgs.length) {
      const colW = (CW - 4) / Math.min(2, imgs.length);
      const placed = imgs.slice(0, 2).map((im) => ({ im, reg: doc.addJpeg(im.bytes!) }));
      const hs = placed.map((p) => (p.reg ? Math.min(92, (colW * p.reg.info.height) / p.reg.info.width) : 20));
      const h = Math.max(...hs);
      w.ensure(h + 16);
      placed.forEach((p, i) => {
        const x = LM + i * (colW + 4);
        if (p.reg) {
          const iw = Math.min(colW, (hs[i] * p.reg.info.width) / p.reg.info.height);
          doc.image(p.reg.name, x, w.y, iw, hs[i]);
          doc.rect(x, w.y, iw, hs[i], { stroke: RULE, lineWidth: 0.2 });
        } else {
          doc.rect(x, w.y, colW, 20, { fill: PANEL, stroke: RULE });
          doc.text("image could not be decoded", x + 3, w.y + 11, { font: "italic", size: 7, color: MUTED });
        }
        wrapText(p.im.caption, colW, "italic", 6.3).slice(0, 4).forEach((line, li) =>
          doc.text(line, x, w.y + h + 3 + li * 2.8, { font: "italic", size: 6.3, color: MUTED }));
      });
      w.y += h + 15;
    }
    const missingImgs = m.images.filter((i) => !i.bytes);
    if (!imgs.length) {
      w.callout("unavailable", "SAR imagery not available in this report", [
        det.synthetic ? "Synthetic demo scene: there is no SAR image." : "No derived SAR image could be loaded for this scene.",
        ...missingImgs.map((i) => `${i.name}: ${i.error ?? "not loaded"}`),
      ]);
    } else if (missingImgs.length) {
      w.callout("warning", "Some SAR images were not available", missingImgs.map((i) => `${i.name}: ${i.error ?? "not loaded"}`));
    }
  } else {
    w.callout("unavailable", "Detection not available", ["The satellite-detection node did not produce a slick for this investigation (see timeline)."]);
  }

  // ---------------- 2 geometry
  w.heading("2", "Spill geometry");
  if (det) {
    const g = det.geometry;
    const ch = m.characterization ?? {};
    w.kv([
      { label: "Area", value: `${fmt(g.area_km2, 3)} km2 (${fmt(g.area_hectares, 1)} ha); basis: ${ch.area_basis ?? "polygon area"}`, status: det.geometry_source ?? null },
      { label: "Perimeter", value: `${fmt(g.perimeter_km, 2)} km; compactness ${fmt(ch.compactness ?? null, 3)} (1 = circle)` },
      { label: "Centroid", value: fmtLatLon(g.centroid, 5) },
      { label: "Bounding box", value: `lat ${fmtLat(g.bbox[1], 4)} .. ${fmtLat(g.bbox[3], 4)}; lon ${fmtLon(g.bbox[0], 4)} .. ${fmtLon(g.bbox[2], 4)}` },
      { label: "Principal axis", value: `${fmt(g.orientation_deg, 1)} deg (${g.orientation_source ?? "n/a"}); polygon second-moment axis ${fmt(g.polygon_principal_axis_deg ?? null, 1)} deg; elongation ${fmt(g.elongation ?? null, 2)}` },
      { label: "Mask pixel count", value: g.pixel_count != null ? `${g.pixel_count} px (${det.geometry_source === "REFERENCE_LABEL" ? "labelled reference mask" : "mask"})` : null },
    ], 36);
    const v = m.vertices;
    w.sub(`Polygon vertices (${v.length}, lon/lat WGS84)`);
    const perRow = 3;
    const rows: Cell[][] = [];
    for (let i = 0; i < v.length; i += perRow) {
      const r: Cell[] = [];
      for (let j = 0; j < perRow; j++) {
        const p = v[i + j];
        r.push(p ? `${i + j + 1}` : "", p ? `${fmtLat(p[1], 5)}, ${fmtLon(p[0], 5)}` : "");
      }
      rows.push(r);
    }
    const vc = CW / perRow;
    w.table(Array.from({ length: perRow }).flatMap(() => [{ title: "#", w: 8 }, { title: "Latitude, longitude", w: vc - 8 }]), rows, { size: 6.6, maxLines: 2 });
  } else w.callout("unavailable", "Geometry not available", ["No slick geometry."]);

  // ---------------- 3 map
  w.heading("3", "Situation map: slick, origin corridor, Future Impact Zone, AIS");
  drawMap(w, m);

  // ---------------- 4 environment
  w.heading("4", "Environmental conditions and data provenance");
  const env = m.environment;
  if (env) {
    w.table(
      [{ title: "Variable", w: 40 }, { title: "Provenance", w: 32 }, { title: "Value at T0 (slick centroid)", w: 62 }, { title: "Source / note", w: CW - 134 }],
      // engine status shown under the chip only when it is more specific than the category (e.g. PERSISTED+EDGE_CLAMPED)
      env.rows.map((r) => [{ text: r.label, bold: true }, { chip: { label: r.category, style: PROVENANCE[r.category] }, text: (r.status ?? "").replace(/_/g, " ") === r.category ? "" : r.status ?? "" }, r.value, r.note ?? ""]),
      { size: 7 },
    );
    if (!env.currentAvailable) w.callout("warning", "Ocean current: NOT AVAILABLE", [
      "No ocean-current product exists for this scene, so no current value is reported anywhere in this report.",
      env.currentPriorSigma != null ? `The drift engine represents the unknown current as a zero-mean random prior (sigma = ${env.currentPriorSigma} m/s per particle). This widens the origin and forecast envelopes; it is an uncertainty model, not an observation.` : "No current prior was applied.",
    ]);
    if (env.windowProvenance.length) {
      w.sub("Provenance of forcing samples used by the drift engine");
      w.table([{ title: "Window", w: 64 }, { title: "Fraction of samples by provenance", w: CW - 64 }], env.windowProvenance.map((x) => [x.label, fractionsText(x.fractions)]), { size: 7 });
      w.para(`ERA5 covers ${env.coverage.backward === null ? "n/a" : Math.round(env.coverage.backward * 100) + " %"} of the backtrack window and ${env.coverage.forward === null ? "n/a" : Math.round(env.coverage.forward * 100) + " %"} of the forecast window. Outside the native times the nearest field is PERSISTED; outside the grid it is EDGE-CLAMPED.`, { size: 7.2, color: MUTED });
    }
    if (env.windSeries.length) {
      w.sub("Native wind fields at the slick centroid");
      w.table([{ title: "Time (UTC)", w: 40 }, { title: "Speed", w: 30 }, { title: "From / toward", w: 50 }, { title: "Provenance", w: CW - 120 }],
        env.windSeries.map((x) => [utc(x.time), `${fmt(x.speed_ms)} m/s`, `${fmt(x.direction_from_deg, 0)} / ${fmt(x.direction_to_deg, 0)} deg`, { chip: provChip(x.status) }]), { size: 7 });
    }
    if (env.windGrid.length) {
      w.sub(`Wind vectors on the native grid at T0 (${env.windGrid.length} points)`);
      w.table([{ title: "Grid point", w: 50 }, { title: "u / v (m/s)", w: 40 }, { title: "Speed", w: 28 }, { title: "From / toward", w: 38 }, { title: "Status", w: CW - 156 }],
        env.windGrid.map((g) => [fmtLatLon([g.lat, g.lon], 2), `${fmt(g.u, 2)} / ${fmt(g.v, 2)}`, `${fmt(g.speed_ms)} m/s`, `${fmt(g.direction_from_deg, 0)} / ${fmt(g.direction_to_deg, 0)}`, { chip: provChip(g.status) }]), { size: 6.8 });
    }
    w.para(`Wind direction vs slick principal axis: ${fmt(env.windSlickDiff, 1)} deg (axial).`, { size: 7.5 });
    if (env.lookalike) w.callout("warning", "SAR look-alike risk", ["Wind at the observation time is below ~3 m/s. Low-wind areas and biogenic films commonly appear dark in SAR. No look-alike classifier is implemented; verify independently."]);
  } else w.callout("unavailable", "Environmental analysis not available", ["The environmental-analysis node did not run."]);

  // ---------------- 5 backward
  w.heading("5", "Backtracked origin (backward Lagrangian ensemble)");
  const bw = m.backward;
  if (bw) {
    w.kv([
      { label: "Origin centroid", value: `${fmtLatLon(bw.final.centroid, 5)} at ${utc(bw.end_time)} (T-${bw.hours} h)` },
      { label: "Uncertainty region", value: `P50 radius ${fmt(bw.final.r50_km)} km, P90 radius ${fmt(bw.final.r90_km)} km, P90 envelope ${fmt(bw.final.hull_area_km2, 1)} km2` },
      { label: "Net displacement", value: `${fmt(bw.final.displacement_km)} km toward ${fmt(bw.final.displacement_bearing_deg, 0)} deg (from the observed slick, backward in time)` },
      { label: "Horizon", value: `${bw.hours} h, analyst-selected. The release time is NOT estimated by the model.` },
      { label: "Ensemble / physics", value: `${bw.num_particles} particles, dt ${bw.timestep_minutes} min, seed ${bw.seed}; wind factor ${bw.forcing.wind_factor}, deflection ${bw.forcing.deflection_deg} deg (${bw.forcing.deflection_sense}); K = ${bw.forcing.eddy_diffusivity_m2s} m2/s; current prior ${bw.forcing.current_prior_applied ? `sigma ${bw.forcing.unknown_current_prior_sigma_ms} m/s` : "not applied"}; ${bw.forcing.integration}` },
    ], 36);
    w.sub("Corridor evolution");
    w.table([{ title: "Time", w: 16 }, { title: "UTC", w: 36 }, { title: "Centroid", w: 52 }, { title: "P50 km", w: 18, align: "right" }, { title: "P90 km", w: 18, align: "right" }, { title: "Envelope km2", w: 22, align: "right" }, { title: "Wind REAL", w: CW - 162, align: "right" }],
      bw.snapshots.map((sn) => [`T-${sn.hours}h`, utc(sn.time), fmtLatLon(sn.centroid, 4), fmt(sn.r50_km), fmt(sn.r90_km), fmt(sn.hull_area_km2, 1), `${Math.round(sn.wind_real_fraction * 100)} %`]), { size: 6.8 });
    if (bw.warnings.length) w.callout("warning", "Backtrack warnings", bw.warnings);
  } else w.callout("unavailable", "Backtrack not available", ["The backward-origin node did not run."]);

  // ---------------- 6 forward
  w.heading("6", "Forward forecast and Future Impact Zone");
  const fw = m.forward;
  if (fw) {
    w.para(`Forward ensemble of ${fw.num_particles} particles seeded on the observed slick at ${utc(fw.start_time)} (dt ${fw.timestep_minutes} min, seed ${fw.seed}). The Future Impact Zone at each horizon is the convex hull of the particles inside the P90 radius around the ensemble centroid, i.e. a transport envelope derived from the particles; it is not a drawn polygon and includes no weathering.`, { size: 7.6 });
    w.table(
      [{ title: "Horizon", w: 16 }, { title: "Time (UTC)", w: 34 }, { title: "Centroid", w: 42 }, { title: "Displacement", w: 36 }, { title: "P50 / P90", w: 24 }, { title: "Envelope", w: 18, align: "right" }, { title: "Wind REAL", w: CW - 170, align: "right" }],
      m.forecastRows.map((r) => [{ text: `T+${r.hours}h`, bold: true, color: horizonRGB(r.hours) }, r.time, r.centroid, r.displacement, `${r.r50} / ${r.r90}`, r.area, r.windReal]),
      { size: 6.8, rowFill: (i) => (m.horizon !== "ALL" && m.forecastRows[i]?.hours === m.horizon ? [221, 244, 255] : i % 2 ? PANEL : null) },
    );
    if (m.horizon !== "ALL") w.para(`Highlighted row: horizon selected in the viewer (T+${m.horizon} h).`, { size: 6.8, color: MUTED, font: "italic" });
    const unsupported = m.forecastRows.filter((r) => r.supported === false);
    w.kv(m.forecastRows.map((r) => ({
      label: `T+${r.hours} h forcing`,
      value: `wind ${r.windReal} REAL, current ${r.currentReal} REAL${r.supported === false ? ` - ${r.supportReason}` : r.supported === true ? " - supported by real forcing coverage" : " - synthetic forcing"}`,
      status: r.supported === false ? "PERSISTED" : r.supported === true ? "REAL" : "SYNTHETIC_DEMO",
    })), 34, 7.0);
    if (unsupported.length) w.callout("warning", "Persistence scenarios, not forecasts", [`Horizons ${unsupported.map((r) => `T+${r.hours}h`).join(", ")} are NOT supported by real forcing coverage (wind is held at the last available field beyond the ERA5 window). They are transport scenarios that show sensitivity to that assumption; they must not be read as forecasts.`]);
    w.callout("unavailable", "Exposure not assessed", ["Coastline, port, protected-area and shipping-lane layers are not bundled, so proximity of the impact zone to sensitive receptors is not computed."]);
    if (fw.warnings.length) w.callout("warning", "Forecast warnings", fw.warnings);
  } else w.callout("unavailable", "Forecast not available", ["The forward-forecast node did not run."]);

  // ---------------- 7 AIS & ranking
  w.heading("7", "AIS candidate vessels and ranking");
  const att = m.attribution;
  if (att && m.ais) {
    w.kv([
      { label: "AIS data", value: `${m.ais.source}; ${m.ais.records} reports, ${m.ais.vessels} vessels, ${m.ais.vessels_active_in_window} active in the backtrack window`, status: m.ais.synthetic ? "SYNTHETIC_DEMO" : "REAL" },
      { label: "Scored / high / medium", value: `${att.total_candidates} scored (${att.excluded_tracks} excluded: <2 reports); ${att.high_priority_count} high-priority band, ${att.medium_priority_count} medium band` },
      { label: "Weights used", value: `spatial ${fmt(att.weights_used.spatial)}, temporal ${fmt(att.weights_used.temporal)}, corridor ${fmt(att.weights_used.trajectory)}, kinematic ${fmt(att.weights_used.consistency)}` },
      { label: "Separation", value: `score gap #1 to #2: ${fmt(att.score_gap_top2, 3)}; attribution uncertainty ${m.attributionUncertainty}` },
    ], 36);
    w.table([{ title: "Factor", w: 26 }, { title: "Definition", w: CW - 26 }], Object.entries(att.factor_definitions).map(([k, v]) => [{ text: k, bold: true }, v]), { size: 6.8 });
    if (att.coverage_warnings.length) w.callout("warning", "AIS coverage", att.coverage_warnings);
    w.sub(`All ${att.candidates.length} scored vessels`, [{ label: `ATTRIBUTION UNCERTAINTY ${m.attributionUncertainty}`, style: UNCERTAINTY[m.attributionUncertainty] ?? UNCERTAINTY["N/A"] }]);
    const hollow = m.attributionUncertainty === "HIGH";
    w.table(
      [{ title: "#", w: 7, align: "right" }, { title: "Vessel", w: 33 }, { title: "MMSI", w: 17 }, { title: "Type", w: 19 }, { title: "Score", w: 22 }, { title: "S", w: 8, align: "right" }, { title: "T", w: 8, align: "right" }, { title: "C", w: 8, align: "right" }, { title: "K", w: 8, align: "right" }, { title: "Slick km", w: 13, align: "right" }, { title: "dt h", w: 11, align: "right" }, { title: "AIS", w: 12 }, { title: "Rank rng", w: CW - 166 }],
      att.candidates.map((c) => [
        String(c.rank),
        { text: c.vessel_name, bold: c.mmsi === m.selectedVessel?.mmsi },
        c.mmsi,
        c.vessel_type,
        { bar: { value: c.composite_score, hollow }, text: fmt(c.composite_score, 3) },
        fmt(c.feature_breakdown.spatial_proximity_score),
        fmt(c.feature_breakdown.temporal_alignment_score),
        fmt(c.feature_breakdown.trajectory_intersection_score),
        fmt(c.feature_breakdown.kinematic_consistency_score),
        fmt(c.metrics.min_distance_to_slick_km, 1),
        fmt(c.metrics.time_delta_hours, 1),
        c.ais_quality.quality_label,
        `${c.sensitivity.rank_min}-${c.sensitivity.rank_max}`,
      ]),
      { size: 6.2, maxLines: 3, rowFill: (i) => (att.candidates[i]?.mmsi === m.selectedVessel?.mmsi ? [221, 244, 255] : i % 2 ? PANEL : null) },
    );
    w.para("S spatial, T temporal, C corridor (trajectory), K kinematic factor scores (0-1). dt = time of closest approach minus T0. Rank rng = rank range when any single factor is removed. Score bands (>=0.75 high, >=0.5 medium) prioritise investigation; they are not probabilities of responsibility.", { size: 6.6, color: MUTED });
  } else w.callout("unavailable", "Candidate ranking not available", ["No AIS data or no backtrack corridor for this investigation."]);

  // ---------------- 8 dossiers
  w.heading("8", "Candidate evidence breakdown");
  if (m.dossiers.length) {
    const hollow = m.attributionUncertainty === "HIGH";
    for (const c of m.dossiers) {
      w.ensure(70);
      w.sub(`#${c.rank} ${c.vessel_name} (MMSI ${c.mmsi})`, [
        { label: `SCORE ${fmt(c.composite_score, 3)}`, style: hedged(c.composite_score >= 0.75 ? EVIDENCE.STRONG : c.composite_score >= 0.5 ? EVIDENCE.MODERATE : EVIDENCE.WEAK, m.attributionUncertainty) },
        { label: `UNCERTAINTY ${m.attributionUncertainty}`, style: UNCERTAINTY[m.attributionUncertainty] ?? UNCERTAINTY["N/A"] },
        ...(c.mmsi === m.selectedVessel?.mmsi ? [{ label: "SELECTED IN VIEWER", style: { fill: MAP.selected, text: [255, 255, 255] as RGB } }] : []),
      ]);
      w.kv([
        { label: "Vessel metadata (AIS static)", value: `${c.vessel_type}; length ${c.length_m ?? "n/a"} m, beam ${c.width_m ?? "n/a"} m; IMO ${c.imo ?? "not reported"}; flag ${c.flag ?? "not reported"}`, status: c.synthetic ? "SYNTHETIC_DEMO" : null },
        { label: "Closest approach to slick", value: `${fmt(c.metrics.min_distance_to_slick_km, 2)} km at ${utc(c.metrics.cpa_timestamp)} (${c.metrics.time_delta_hours >= 0 ? "+" : ""}${fmt(c.metrics.time_delta_hours, 2)} h vs T0), ${fmtLatLon(c.metrics.cpa_coordinates, 4)}; SOG ${fmt(c.metrics.cpa_speed_knots, 1)} kn, COG ${c.metrics.cpa_course_deg == null ? "n/a" : fmt(c.metrics.cpa_course_deg, 0) + " deg"}` },
        { label: "Backtracked corridor", value: c.metrics.corridor_samples_with_position === 0 ? "no AIS positions during the backtrack window: not assessable" : `${c.metrics.intersects_origin ? "enters" : "does not enter"} the P90 corridor; closest ${fmt(c.metrics.corridor_min_distance_km, 2)} km from corridor centre (P90 radius ${fmt(c.metrics.corridor_r90_at_best_km, 2)} km) at ${utc(c.metrics.corridor_best_time)}` },
        { label: "AIS data quality", value: `${c.ais_quality.quality_label}: ${c.ais_quality.n_points} reports (${c.ais_quality.n_points_in_window} in window), window coverage ${Math.round(c.ais_quality.window_coverage_fraction * 100)} %, max gap ${fmt(c.ais_quality.max_gap_in_window_min, 0)} min, median interval ${fmt(c.ais_quality.median_interval_min, 1)} min, speed outliers ${c.ais_quality.implied_speed_outliers}` },
        { label: "Rank sensitivity", value: `rank ${c.rank}; without spatial ${c.sensitivity.rank_without_spatial}, temporal ${c.sensitivity.rank_without_temporal}, corridor ${c.sensitivity.rank_without_trajectory}, kinematic ${c.sensitivity.rank_without_kinematic} (${c.sensitivity.stable ? "stable" : "UNSTABLE"})` },
        { label: "2018 offline baseline", value: c.baseline_offline_score != null ? fmt(c.baseline_offline_score, 3) : "not applicable" },
        { label: "Exact Shapley contributions", value: c.explanation ? `vs mean vessel ${fmt(c.explanation.base_value, 3)}: spatial ${fmt(c.explanation.contributions.spatial, 3)}, temporal ${fmt(c.explanation.contributions.temporal, 3)}, corridor ${fmt(c.explanation.contributions.trajectory, 3)}, kinematic ${fmt(c.explanation.contributions.consistency, 3)} (linear score: exact, not a learned model)` : null },
      ], 40, 7.2);
      const fb = c.feature_breakdown;
      const fdef = m.attribution?.factor_definitions ?? {};
      w.table(
        [{ title: "Factor", w: 22 }, { title: "Score", w: 30 }, { title: "Weight", w: 15, align: "right" }, { title: "Contribution", w: 20, align: "right" }, { title: "Measured as", w: CW - 87 }],
        ([["Spatial", fb.spatial_proximity_score, "spatial"], ["Temporal", fb.temporal_alignment_score, "temporal"], ["Corridor", fb.trajectory_intersection_score, "trajectory"], ["Kinematic", fb.kinematic_consistency_score, "consistency"]] as [string, number, keyof typeof fb.weights_used][]).map(([name, v, k]) => [
          { text: name, bold: true }, { bar: { value: v, hollow }, text: fmt(v, 3) }, fmt(fb.weights_used[k]), `+${fmt(fb.weighted_contributions[k], 3)}`, fdef[k] ?? "",
        ]),
        { size: 6.8 },
      );
      if (c.why_priority.length) { w.para("Why this vessel is a priority candidate:", { size: 7.4, font: "bold" }); w.bullets(c.why_priority, { prefix: "+", color: EVIDENCE.STRONG.fill, size: 7.2 }); }
      if (c.contradicting_evidence.length) { w.para("Contradicting or limiting evidence:", { size: 7.4, font: "bold" }); w.bullets(c.contradicting_evidence, { prefix: "-", color: CALLOUT.warning.title, size: 7.2 }); }
      w.para(c.scientific_disclaimer, { size: 6.6, font: "italic", color: MUTED });
      w.y += 2;
    }
  } else w.callout("unavailable", "No candidate dossiers", ["No candidates were scored."]);

  // ---------------- 8b counterfactuals (only when run by the investigator)
  if (m.counterfactuals.length) {
    w.heading("8b", "Counterfactual analyses (analytical scenarios)");
    w.callout("info", "ANALYTICAL SCENARIOS", ["Computed with the same engines on this investigation. They describe what the analysis would conclude under changed assumptions; they are not observations or historical facts."]);
    for (const r of m.counterfactuals) {
      w.sub(r.question);
      if (r.kind === "exclude_vessel") {
        w.kv([
          { label: "Excluded", value: `${r.excluded.vessel_name} (MMSI ${r.excluded.mmsi}), rank ${r.excluded.rank_before}, score ${fmt(r.excluded.score, 3)}` },
          { label: "Top candidate", value: `${r.top_candidate_changed ? "CHANGES" : "unchanged"}: ${r.top_before[0]?.vessel_name ?? "n/a"} -> ${r.top_after[0]?.vessel_name ?? "n/a"}; gap #1-#2 ${fmt(r.score_gap_top2_before, 3)} -> ${fmt(r.score_gap_top2_after, 3)}` },
          { label: "Hypothesis balance", value: r.hypotheses.map((h: any) => `${h.id} ${h.balance_before ?? "n/a"} -> ${h.balance_after ?? "n/a"}`).join("; ") },
        ], 36, 7.2);
      } else {
        w.table([{ title: "Scenario", w: 62 }, { title: "Origin shift", w: 22, align: "right" }, { title: "Origin P90", w: 22, align: "right" }, { title: "Top candidate", w: 50 }, { title: "Top-3", w: CW - 156, align: "right" }],
          r.scenarios.map((s: any) => [s.label, `${fmt(s.origin_shift_km, 2)} km`, `${fmt(s.origin_r90_km, 1)} km`, s.top_candidate ? `${s.top_candidate.vessel_name} ${fmt(s.top_candidate.score, 3)}` : null, `${s.top3_overlap_with_run}/3`]), { size: 6.8 });
        w.para(r.conclusion_stable ? "Top candidate identical in every forcing scenario." : "The top candidate DEPENDS on the forcing assumptions.", { size: 7.4, font: "bold" });
      }
      w.para(r.note, { size: 6.8, font: "italic", color: MUTED });
    }
  }

  // ---------------- 9 hypotheses
  w.heading("9", "Competing hypotheses");
  if (m.hypotheses.length) {
    w.para("Evidence balance = supporting strength / (supporting + contradicting strength). It is a transparent heuristic for weighing evidence, not a probability.", { size: 7, color: MUTED, font: "italic" });
    for (const h of m.hypotheses) {
      w.ensure(26);
      w.sub(`${h.id}  ${h.title}`, [
        { label: `EVIDENCE ${h.evidence_strength}`, style: hedged(EVIDENCE[h.evidence_strength] ?? EVIDENCE.NONE, h.uncertainty) },
        { label: `UNCERTAINTY ${h.uncertainty}`, style: UNCERTAINTY[h.uncertainty] ?? UNCERTAINTY["N/A"] },
      ]);
      w.para(h.statement, { size: 7.6 });
      w.ensure(6);
      doc.text("Evidence balance", LM, w.y + 2.6, { size: 7, color: MUTED });
      w.bar(LM + 24, w.y + 0.4, 60, h.evidence_balance ?? 0, h.uncertainty === "HIGH");
      doc.text(h.evidence_balance === null ? "no evidence" : fmt(h.evidence_balance, 2), LM + 87, w.y + 2.6, { size: 7, font: "bold", color: INK });
      w.y += 5;
      const lbl = (n: number) => (n >= 3 ? "strong" : n === 2 ? "moderate" : "weak");
      if (h.supporting.length) w.bullets(h.supporting.map((e) => `[${lbl(e.strength)}] ${e.text} (${e.source})`), { prefix: "+", color: EVIDENCE.STRONG.fill, size: 7 });
      if (h.contradicting.length) w.bullets(h.contradicting.map((e) => `[${lbl(e.strength)}] ${e.text} (${e.source})`), { prefix: "-", color: CALLOUT.warning.title, size: 7 });
      if (h.missing_evidence.length) w.para(`Missing evidence: ${h.missing_evidence.join("; ")}`, { size: 7, color: MUTED, font: "italic" });
      w.y += 1.5;
    }
  } else w.callout("unavailable", "Hypotheses not available", ["The competing-hypotheses node did not run."]);

  // ---------------- 10 uncertainty
  w.heading("10", "Uncertainty (reported separately from scores)");
  if (m.uncertainty) {
    w.sub("Overall", [{ label: `UNCERTAINTY ${m.uncertainty.overall}`, style: UNCERTAINTY[m.uncertainty.overall] ?? UNCERTAINTY["N/A"] }]);
    w.table([{ title: "Component", w: 34 }, { title: "Level", w: 26 }, { title: "Basis", w: CW - 60 }],
      m.uncertainty.components.map((c) => [{ text: c.component, bold: true }, { chip: { label: c.level, style: UNCERTAINTY[c.level] ?? UNCERTAINTY["N/A"] } }, c.basis]), { size: 7.2 });
    w.para(m.uncertainty.note, { size: 7, color: MUTED, font: "italic" });
  } else w.callout("unavailable", "Uncertainty not available", ["The uncertainty node did not run."]);

  // ---------------- 11 risk
  w.heading("11", "Risk assessment");
  if (m.risk) {
    w.sub("Risk level", [{ label: m.risk.level, style: RISK[m.risk.level] ?? RISK.UNKNOWN }]);
    w.para(m.risk.rationale, { size: 7.6 });
    w.table([{ title: "Factor", w: 60 }, { title: "Value", w: 50 }, { title: "Category", w: CW - 110 }],
      m.risk.factors.map((f) => [{ text: f.name, bold: true }, f.value, f.category === "UNKNOWN" ? { chip: { label: "NOT ASSESSED", style: PROVENANCE["NOT AVAILABLE"] } } : f.category]), { size: 7.2 });
    w.para(m.risk.method, { size: 7, color: MUTED, font: "italic" });
  } else w.callout("unavailable", "Risk not available", ["The risk node did not run."]);

  // ---------------- 12 response
  w.heading("12", "Recommended response");
  if (m.recommendations.length) {
    w.table([{ title: "Priority", w: 24 }, { title: "Action", w: 92 }, { title: "Rationale", w: CW - 116 }],
      m.recommendations.map((r) => [{ chip: { label: r.priority, style: URGENCY[r.priority] ?? URGENCY.ROUTINE } }, { text: r.action, bold: true }, r.rationale]), { size: 7.2 });
  } else w.callout("unavailable", "No recommendations", ["The response-recommendation node did not run."]);

  // ---------------- 13 timeline
  w.heading("13", "Investigation timeline (agent graph execution)");
  w.para(`${m.runtime}. ${m.timeline.length} node events recorded by the server as the nodes executed.`, { size: 7, color: MUTED });
  const byNode = new Map<string, { label: string; start?: string; end?: string; status: string; dur?: number; summary?: string; warnings: number; error?: string; conf?: string }>();
  for (const e of m.timeline) {
    const r = byNode.get(e.node) ?? { label: e.label, status: e.status, warnings: 0 };
    if (e.status === "running") r.start = e.at;
    else { r.end = e.at; r.status = e.status; r.dur = e.duration_ms; r.summary = e.summary; r.warnings = e.warnings?.length ?? 0; r.error = e.error; r.conf = e.confidence ? `${e.confidence.level} (${e.confidence.basis})` : undefined; }
    byNode.set(e.node, r);
  }
  w.table([{ title: "Node", w: 30 }, { title: "Status", w: 22 }, { title: "Started / ended (UTC)", w: 30 }, { title: "ms", w: 12, align: "right" }, { title: "Output summary / confidence", w: CW - 94 }],
    [...byNode.values()].map((r) => [
      { text: r.label, bold: true }, { chip: { label: r.status.toUpperCase(), style: NODE_STATUS[r.status] ?? NODE_STATUS.pending } },
      `${r.start ? r.start.slice(11, 23) : "-"}\n${r.end ? r.end.slice(11, 23) : "-"}`, r.dur != null ? fmt(r.dur, 1) : "-",
      [r.error ? `FAILED: ${r.error}` : r.summary ?? "", r.conf ? `Confidence: ${r.conf}` : "", r.warnings ? `${r.warnings} warning(s)` : ""].filter(Boolean).join("\n"),
    ]), { size: 6.6, maxLines: 8 });

  // ---------------- 14 sources
  w.heading("14", "Data sources and provenance");
  w.kv(m.dataSources, 40, 7.2);

  // ---------------- 15 limitations & warnings
  w.heading("15", "Scientific limitations and warnings");
  w.bullets(m.limitations, { size: 7.4 });
  if (m.warnings.length) { w.y += 2; w.callout("warning", `Investigation warnings (${m.warnings.length})`, m.warnings, 7.2); }

  // ---------------- 16 disclaimer
  w.heading("16", "Disclaimer");
  w.callout("disclaimer", "PROBABILISTIC INVESTIGATIVE EVIDENCE - NOT LEGAL PROOF", m.disclaimers, 7.8);

  // ---------------- footers
  const n = doc.pageCount;
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.line(LM, 285, RM, 285, { stroke: RULE, lineWidth: 0.2 });
    doc.text(fitText(`AEGIS decision-support report | ${m.incidentId} | generated ${utc(m.generatedAt)}`, 150, "regular", 6.3), LM, 288.5, { size: 6.3, color: MUTED });
    doc.text(`Page ${i} of ${n}`, RM, 288.5, { size: 6.3, color: MUTED, align: "right", font: "bold" });
    doc.text("Vessel attribution is probabilistic investigative evidence, NOT legal proof.", LM, 291.8, { size: 6.3, color: BRAND, font: "bold" });
  }
  return { bytes: doc.toBytes(), pages: n };
}
