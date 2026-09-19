/**
 * Minimal, dependency-free PDF 1.4 writer used by the AEGIS incident report.
 *
 * Why not jsPDF: it cannot be installed or executed in the offline build
 * environment, so a jsPDF implementation would have shipped untested. This
 * writer produces standard PDF that is verified in the test-suite with
 * poppler/qpdf. It runs identically in the browser and in Node.
 *
 * Scope (deliberately small):
 *  - A4 portrait pages, millimetre coordinates with a top-left origin
 *  - Core-14 fonts Helvetica / Helvetica-Bold / Helvetica-Oblique with
 *    WinAnsiEncoding and exact AFM advance widths (text measuring + wrapping)
 *  - Unicode text is transliterated to WinAnsi explicitly (no mojibake)
 *  - Filled/stroked rectangles, lines, polygons, circles, dash patterns,
 *    fill/stroke opacity (ExtGState), rectangular clipping
 *  - Baseline/progressive JPEG images (DCTDecode passthrough, gray or RGB)
 *
 * Everything written is 7-bit ASCII except the JPEG stream bytes, so byte
 * offsets for the cross-reference table are exact.
 */

import { HELVETICA_WIDTHS, HELVETICA_BOLD_WIDTHS, WINANSI_EXTRA } from "./fontMetrics";

export type RGB = [number, number, number];
export type FontStyle = "regular" | "bold" | "italic";

export interface ShapeStyle {
  fill?: RGB | null;
  stroke?: RGB | null;
  lineWidth?: number; // mm
  dash?: number[] | null; // mm
  fillOpacity?: number;
  strokeOpacity?: number;
}

export interface TextStyle {
  font?: FontStyle;
  size?: number; // pt
  color?: RGB;
  align?: "left" | "center" | "right";
}

const MM = 72 / 25.4; // points per millimetre
const FONT_RES: Record<FontStyle, string> = { regular: "F1", bold: "F2", italic: "F3" };

// --------------------------------------------------------------------------
// text encoding
// --------------------------------------------------------------------------

/** Explicit transliterations for characters outside WinAnsi. */
const TRANSLIT: Record<string, string> = {
  "\u2192": "->", "\u2190": "<-", "\u2194": "<->", "\u21D2": "=>", "\u2265": ">=", "\u2264": "<=",
  "\u2248": "~", "\u2260": "!=", "\u2212": "-", "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2015": "-",
  "\u0394": "delta ", "\u03C3": "sigma", "\u03BC": "u", "\u221A": "sqrt", "\u221E": "inf", "\u2211": "sum",
  "\u26A0": "(!)", "\u25CF": "*", "\u25CB": "o", "\u25C7": "<>", "\u25B2": "^", "\u25BC": "v", "\u2713": "ok", "\u2717": "x",
  "\u2080": "0", "\u2081": "1", "\u2082": "2", "\u2083": "3", "\u2084": "4", "\u2085": "5", "\u2086": "6", "\u2087": "7", "\u2088": "8", "\u2089": "9",
  "\u00A0": " ", "\u2009": " ", "\u200A": " ", "\u202F": " ", "\u2002": " ", "\u2003": " ",
};

/** Map a JS string to WinAnsi byte codes (32..255). Unknown characters become "?". */
export function toWinAnsi(input: string): number[] {
  const out: number[] = [];
  const s = String(input ?? "").normalize("NFC");
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 9) { out.push(32, 32); continue; }
    if (cp === 10 || cp === 13) { out.push(32); continue; }
    if ((cp >= 32 && cp <= 126) || (cp >= 0xa0 && cp <= 0xff)) { out.push(cp); continue; }
    if (WINANSI_EXTRA[cp] !== undefined) { out.push(WINANSI_EXTRA[cp]); continue; }
    const t = TRANSLIT[ch];
    if (t !== undefined) { for (const c of t) out.push(c.charCodeAt(0)); continue; }
    // strip combining marks from decomposed forms, else "?"
    const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const b = base.codePointAt(0) ?? 63;
    out.push(base.length === 1 && b >= 32 && b <= 255 && b !== 127 ? b : 63);
  }
  return out;
}

/** Sanitised display string (what will actually be printed). */
export function sanitize(input: string): string {
  return toWinAnsi(input).map((c) => String.fromCharCode(c)).join("");
}

function pdfStringLiteral(codes: number[]): string {
  let s = "(";
  for (const c of codes) {
    if (c === 40 || c === 41 || c === 92) s += "\\" + String.fromCharCode(c);
    else if (c < 32 || c > 126) s += "\\" + c.toString(8).padStart(3, "0");
    else s += String.fromCharCode(c);
  }
  return s + ")";
}

function widthTable(font: FontStyle): number[] {
  return font === "bold" ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS;
}

/** Advance width in mm of a string at `size` pt. */
export function measureText(text: string, font: FontStyle = "regular", size = 9): number {
  const w = widthTable(font);
  let units = 0;
  for (const c of toWinAnsi(text)) units += w[c - 32] ?? 556;
  return ((units / 1000) * size) / MM;
}

/**
 * Greedy word wrap using real glyph widths. Explicit "\n" starts a new line.
 * Words longer than the width are broken at character level, so nothing can
 * overflow the column.
 */
export function wrapText(text: string, maxWidth: number, font: FontStyle = "regular", size = 9): string[] {
  const lines: string[] = [];
  // split on explicit newlines BEFORE sanitising (sanitize maps "\n" to " ")
  const raw = String(text ?? "").replace(/\r/g, "").split("\n");
  for (let pi = 0; pi < raw.length; pi++) {
    const words = sanitize(raw[pi]).split(/ +/).filter((w) => w.length > 0);
    if (!words.length) { lines.push(""); continue; }
    let cur = "";
    for (const word of words) {
      const candidate = cur ? cur + " " + word : word;
      if (measureText(candidate, font, size) <= maxWidth) { cur = candidate; continue; }
      if (cur) { lines.push(cur); cur = ""; }
      if (measureText(word, font, size) <= maxWidth) { cur = word; continue; }
      // over-long token (paths, IDs): break after the last "/", "_", "-" or "."
      // that fits; fall back to a character break only if there is none
      let chunk = "";
      for (const ch of word) {
        if (measureText(chunk + ch, font, size) > maxWidth && chunk) {
          const cut = Math.max(chunk.lastIndexOf("/"), chunk.lastIndexOf("_"), chunk.lastIndexOf("-"), chunk.lastIndexOf("."));
          if (cut > 0 && cut < chunk.length - 1) { lines.push(chunk.slice(0, cut + 1)); chunk = chunk.slice(cut + 1); }
          else { lines.push(chunk); chunk = ""; }
        }
        chunk += ch;
      }
      cur = chunk;
    }
    lines.push(cur);
  }
  return lines;
}

/** Truncate a single line to fit, adding "..." if needed. */
export function fitText(text: string, maxWidth: number, font: FontStyle = "regular", size = 9): string {
  const s = sanitize(text);
  if (measureText(s, font, size) <= maxWidth) return s;
  let out = s;
  while (out.length > 0 && measureText(out + "...", font, size) > maxWidth) out = out.slice(0, -1);
  return out + "...";
}

// --------------------------------------------------------------------------
// JPEG
// --------------------------------------------------------------------------

export interface JpegInfo { width: number; height: number; components: 1 | 3 }

/** Reads dimensions/components from the SOF segment; null if not a supported JPEG. */
export function parseJpeg(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const comps = bytes[i + 9];
      if (!width || !height || (comps !== 1 && comps !== 3)) return null;
      return { width, height, components: comps as 1 | 3 };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}

// --------------------------------------------------------------------------
// document
// --------------------------------------------------------------------------

const f3 = (n: number) => (Math.round(n * 1000) / 1000).toString();
const col = (c: RGB) => `${f3(c[0] / 255)} ${f3(c[1] / 255)} ${f3(c[2] / 255)}`;

interface ImageEntry { name: string; bytes: Uint8Array; info: JpegInfo }

export class PdfDoc {
  readonly width = 210;
  readonly height = 297;
  private pages: string[][] = [];
  private cur = -1;
  private images: ImageEntry[] = [];
  private gstates = new Map<string, string>();
  private info: Record<string, string>;

  constructor(meta: { title?: string; author?: string; subject?: string; creationDate?: Date } = {}) {
    const d = meta.creationDate ?? new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    this.info = {
      Title: meta.title ?? "AEGIS report",
      Author: meta.author ?? "AEGIS",
      Subject: meta.subject ?? "",
      Producer: "AEGIS minimal PDF writer",
      CreationDate: `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`,
    };
  }

  get pageCount(): number { return this.pages.length; }
  get currentPage(): number { return this.cur + 1; }

  addPage(): void { this.pages.push([]); this.cur = this.pages.length - 1; }

  setPage(n: number): void {
    if (n < 1 || n > this.pages.length) throw new Error(`page ${n} out of range`);
    this.cur = n - 1;
  }

  private op(s: string) {
    if (this.cur < 0) this.addPage();
    this.pages[this.cur].push(s);
  }

  private X(x: number) { return f3(x * MM); }
  private Y(y: number) { return f3((this.height - y) * MM); }

  private gs(fill?: number, stroke?: number): string {
    const ca = fill === undefined ? 1 : Math.max(0, Math.min(1, fill));
    const CA = stroke === undefined ? 1 : Math.max(0, Math.min(1, stroke));
    if (ca === 1 && CA === 1) return "";
    const key = `${f3(ca)}/${f3(CA)}`;
    if (!this.gstates.has(key)) this.gstates.set(key, `GS${this.gstates.size + 1}`);
    return `/${this.gstates.get(key)} gs `;
  }

  private styleOps(st: ShapeStyle): { pre: string; paint: string } | null {
    const hasFill = !!st.fill;
    const hasStroke = !!st.stroke;
    if (!hasFill && !hasStroke) return null;
    let pre = this.gs(hasFill ? st.fillOpacity : undefined, hasStroke ? st.strokeOpacity : undefined);
    if (hasFill) pre += `${col(st.fill!)} rg `;
    if (hasStroke) {
      pre += `${col(st.stroke!)} RG ${f3((st.lineWidth ?? 0.2) * MM)} w `;
      pre += st.dash && st.dash.length ? `[${st.dash.map((d) => f3(d * MM)).join(" ")}] 0 d ` : "[] 0 d ";
    }
    return { pre, paint: hasFill && hasStroke ? "B" : hasFill ? "f" : "S" };
  }

  rect(x: number, y: number, w: number, h: number, st: ShapeStyle): void {
    const s = this.styleOps(st);
    if (!s) return;
    this.op(`q ${s.pre}${this.X(x)} ${f3((this.height - y - h) * MM)} ${f3(w * MM)} ${f3(h * MM)} re ${s.paint} Q`);
  }

  line(x1: number, y1: number, x2: number, y2: number, st: ShapeStyle): void {
    this.polyline([[x1, y1], [x2, y2]], { ...st, fill: null });
  }

  polyline(pts: [number, number][], st: ShapeStyle): void {
    const clean = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (clean.length < 2) return;
    const s = this.styleOps({ ...st, fill: null });
    if (!s) return;
    const path = clean.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? "l" : "m"}`).join(" ");
    this.op(`q ${s.pre}1 J 1 j ${path} S Q`);
  }

  polygon(pts: [number, number][], st: ShapeStyle): void {
    const clean = pts.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (clean.length < 3) return;
    const s = this.styleOps(st);
    if (!s) return;
    const path = clean.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? "l" : "m"}`).join(" ");
    this.op(`q ${s.pre}1 j ${path} h ${s.paint} Q`);
  }

  circle(cx: number, cy: number, r: number, st: ShapeStyle): void {
    const s = this.styleOps(st);
    if (!s || !(r > 0)) return;
    const k = 0.5523 * r;
    const P = (x: number, y: number) => `${this.X(x)} ${this.Y(y)}`;
    const path =
      `${P(cx + r, cy)} m ${P(cx + r, cy - k)} ${P(cx + k, cy - r)} ${P(cx, cy - r)} c ` +
      `${P(cx - k, cy - r)} ${P(cx - r, cy - k)} ${P(cx - r, cy)} c ` +
      `${P(cx - r, cy + k)} ${P(cx - k, cy + r)} ${P(cx, cy + r)} c ` +
      `${P(cx + k, cy + r)} ${P(cx + r, cy + k)} ${P(cx + r, cy)} c`;
    this.op(`q ${s.pre}${path} h ${s.paint} Q`);
  }

  /** Draws text with its baseline at y (mm). Returns the advance width (mm). */
  text(str: string, x: number, y: number, st: TextStyle = {}): number {
    const font = st.font ?? "regular";
    const size = st.size ?? 9;
    const codes = toWinAnsi(str);
    const w = measureText(str, font, size);
    const x0 = st.align === "right" ? x - w : st.align === "center" ? x - w / 2 : x;
    if (!codes.length) return 0;
    this.op(`q ${col(st.color ?? [0, 0, 0])} rg BT /${FONT_RES[font]} ${f3(size)} Tf 1 0 0 1 ${this.X(x0)} ${this.Y(y)} Tm ${pdfStringLiteral(codes)} Tj ET Q`);
    return w;
  }

  /** Registers a JPEG; returns an image name or null if unsupported. */
  addJpeg(bytes: Uint8Array): { name: string; info: JpegInfo } | null {
    const info = parseJpeg(bytes);
    if (!info) return null;
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, bytes, info });
    return { name, info };
  }

  image(name: string, x: number, y: number, w: number, h: number): void {
    if (!this.images.some((i) => i.name === name)) return;
    this.op(`q ${f3(w * MM)} 0 0 ${f3(h * MM)} ${this.X(x)} ${f3((this.height - y - h) * MM)} cm /${name} Do Q`);
  }

  /** Clip subsequent drawing (inside fn) to a rectangle. */
  clip(x: number, y: number, w: number, h: number, fn: () => void): void {
    this.op(`q ${this.X(x)} ${f3((this.height - y - h) * MM)} ${f3(w * MM)} ${f3(h * MM)} re W n`);
    try { fn(); } finally { this.op("Q"); }
  }

  /** Serialises the document. */
  toBytes(): Uint8Array {
    if (!this.pages.length) this.addPage();
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const offsets: number[] = [];
    const ascii = (s: string) => {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      return b;
    };
    const push = (b: Uint8Array) => { chunks.push(b); offset += b.length; };
    const obj = (n: number, body: string | Uint8Array[], ) => {
      offsets[n] = offset;
      if (typeof body === "string") push(ascii(`${n} 0 obj\n${body}\nendobj\n`));
      else { push(ascii(`${n} 0 obj\n`)); body.forEach(push); push(ascii(`\nendobj\n`)); }
    };

    push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary comment

    // object numbering
    const nFonts = 3;
    const fontStart = 4;
    const imgStart = fontStart + nFonts;
    const gsStart = imgStart + this.images.length;
    const gsList = [...this.gstates.entries()];
    const pageStart = gsStart + gsList.length;
    const infoObj = pageStart + this.pages.length * 2;

    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = this.pages.map((_, i) => `${pageStart + i * 2} 0 R`).join(" ");
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    const xobj = this.images.map((im, i) => `/${im.name} ${imgStart + i} 0 R`).join(" ");
    const gsd = gsList.map(([, name], i) => `/${name} ${gsStart + i} 0 R`).join(" ");
    obj(3, `<< /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> /XObject << ${xobj} >> /ExtGState << ${gsd} >> /ProcSet [/PDF /Text /ImageB /ImageC] >>`);
    ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique"].forEach((f, i) =>
      obj(fontStart + i, `<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    this.images.forEach((im, i) => {
      const cs = im.info.components === 1 ? "/DeviceGray" : "/DeviceRGB";
      obj(imgStart + i, [
        ascii(`<< /Type /XObject /Subtype /Image /Width ${im.info.width} /Height ${im.info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`),
        im.bytes,
        ascii("\nendstream"),
      ]);
    });
    gsList.forEach(([key], i) => {
      const [ca, CA] = key.split("/");
      obj(gsStart + i, `<< /Type /ExtGState /ca ${ca} /CA ${CA} >>`);
    });
    const W = f3(this.width * MM), H = f3(this.height * MM);
    this.pages.forEach((ops, i) => {
      const content = ops.join("\n");
      obj(pageStart + i * 2, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources 3 0 R /Contents ${pageStart + i * 2 + 1} 0 R >>`);
      obj(pageStart + i * 2 + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    });
    // Info strings use PDFDocEncoding, which differs from WinAnsi only in 0x80-0x9F:
    // map that block to ASCII so e.g. an em dash never turns into another glyph.
    const DOC_FIX: Record<number, string> = { 0x91: "'", 0x92: "'", 0x93: '"', 0x94: '"', 0x96: "-", 0x97: "-", 0x85: "...", 0x95: "*", 0x80: "EUR", 0x99: "(TM)" };
    const docEnc = (v: string) => toWinAnsi(v).flatMap((c) => (c >= 0x80 && c <= 0x9f ? [...(DOC_FIX[c] ?? "?")].map((x) => x.charCodeAt(0)) : [c]));
    const infoStr = Object.entries(this.info).map(([k, v]) => `/${k} ${pdfStringLiteral(docEnc(v))}`).join(" ");
    obj(infoObj, `<< ${infoStr} >>`);

    const xrefAt = offset;
    const total = infoObj + 1;
    let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let n = 1; n < total; n++) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
    push(ascii(xref));
    push(ascii(`trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`));

    const out = new Uint8Array(offset);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
}
