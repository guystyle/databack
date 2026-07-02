import React, { useState, useRef, useEffect, useCallback } from "react";
import { Upload, Download, Camera, Aperture, Clock, Gauge } from "lucide-react";

// ---------- EXIF PARSER (hand-rolled, no external deps) ----------
// Covers baseline TIFF/EXIF tags in standard-JPEG APP1 segments.
// Not guaranteed to cover every camera/edge case (HEIC, malformed APP1, etc).

const FORMAT_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

function readIFD(view, tiffStart, ifdOffset, little) {
  const get16 = (o) => view.getUint16(o, little);
  const get32 = (o) => view.getUint32(o, little);
  const numEntries = get16(ifdOffset);
  const tags = {};
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = get16(entryOffset);
    const format = get16(entryOffset + 2);
    const numComponents = get32(entryOffset + 4);
    const size = (FORMAT_SIZES[format] || 1) * numComponents;
    let valueOffset = entryOffset + 8;
    if (size > 4) valueOffset = tiffStart + get32(entryOffset + 8);

    let value;
    try {
      if (format === 2) {
        let str = "";
        for (let j = 0; j < numComponents - 1; j++) {
          const c = view.getUint8(valueOffset + j);
          if (c === 0) break;
          str += String.fromCharCode(c);
        }
        value = str.trim();
      } else if (format === 3) {
        value = get16(valueOffset);
      } else if (format === 4) {
        value = get32(valueOffset);
      } else if (format === 5 || format === 10) {
        const num = get32(valueOffset);
        const den = get32(valueOffset + 4);
        value = den !== 0 ? num / den : 0;
      } else {
        value = get32(valueOffset);
      }
    } catch (e) {
      value = null;
    }
    tags[tag] = value;
  }
  return tags;
}

function parseTiff(view, tiffOffset) {
  const byteOrderMark = view.getUint16(tiffOffset);
  const little = byteOrderMark === 0x4949;
  const get32 = (o) => view.getUint32(o, little);
  const firstIFDOffset = get32(tiffOffset + 4);
  const ifd0 = readIFD(view, tiffOffset, tiffOffset + firstIFDOffset, little);
  let exif = {};
  if (ifd0[0x8769]) {
    exif = readIFD(view, tiffOffset, tiffOffset + ifd0[0x8769], little);
  }
  return {
    Make: ifd0[0x010f] || null,
    Model: ifd0[0x0110] || null,
    Orientation: ifd0[0x0112] || 1,
    LensModel: exif[0xa434] || null,
    ExposureTime: exif[0x829a] ?? null,
    FNumber: exif[0x829d] ?? null,
    ISO: exif[0x8827] ?? null,
    FocalLength: exif[0x920a] ?? null,
    DateTimeOriginal: exif[0x9003] || ifd0[0x0132] || null,
  };
}

function parseExif(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint16(0) !== 0xffd8) return null; // not a JPEG
  let offset = 2;
  const length = view.byteLength;
  while (offset < length - 4) {
    const marker = view.getUint16(offset);
    if (marker === 0xffe1) {
      const exifHeaderCheck = view.getUint32(offset + 4);
      if (exifHeaderCheck === 0x45786966) {
        // 'Exif'
        const tiffOffset = offset + 10;
        try {
          return parseTiff(view, tiffOffset);
        } catch (e) {
          return null;
        }
      }
    }
    if (marker === 0xffda) break; // start of scan — pixel data begins
    if ((marker & 0xff00) !== 0xff00) break; // malformed
    const segLength = view.getUint16(offset + 2);
    offset += 2 + segLength;
  }
  return null;
}

// ---------- formatting helpers ----------
function fmtExposure(v) {
  if (v === null || v === undefined) return null;
  if (v <= 0) return null;
  if (v < 1) return `1/${Math.round(1 / v)}s`;
  return `${v.toFixed(v % 1 === 0 ? 0 : 1)}s`;
}
function fmtFNumber(v) {
  if (v === null || v === undefined) return null;
  return `f/${v.toFixed(1).replace(/\.0$/, "")}`;
}
function fmtFocal(v) {
  if (v === null || v === undefined) return null;
  return `${Math.round(v)}mm`;
}
function fmtISO(v) {
  if (v === null || v === undefined) return null;
  return `ISO ${v}`;
}
function fmtDate(v) {
  if (!v) return null;
  // EXIF format: "YYYY:MM:DD HH:MM:SS"
  const m = v.match(/(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return v;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// ---------- frame styles ----------
const STYLES = {
  film: {
    label: "Film Frame",
    bg: "#1c1a17",
    border: 48,
    bottomExtra: 130,
    textColor: "#c4581f",
    labelColor: "#8a8577",
  },
  polaroid: {
    label: "Polaroid",
    bg: "#efe9dc",
    border: 36,
    bottomExtra: 120,
    textColor: "#2b2824",
    labelColor: "#8a8577",
  },
  databack: {
    label: "Data Back",
    bg: null, // image bleeds full frame, no border
    border: 0,
    bottomExtra: 0,
    textColor: "#ff5a1f",
    labelColor: "#ff5a1f",
  },
  lcd: {
    label: "LCD",
    bg: null, // overlay panel on top of the full-bleed image
    border: 0,
    bottomExtra: 0,
    textColor: "#1a1f16",
    labelColor: "#1a1f16",
  },
};

// ---------- 7-segment databack renderer ----------
const SEG = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc",
  "5": "afgcd", "6": "afgecd", "7": "abc", "8": "abcdefg", "9": "abcdfg",
};
const DB_SLANT = 0.09; // italic shear (smaller = more upright)

// draw one seven-segment digit into ctx with italic shear around baseline (y+h)
// slant defaults to the databack tuning; pass 0 for upright (LCD) glyphs.
function drawSegDigit(ctx, x, y, w, h, ch, t, slant = DB_SLANT) {
  const segs = SEG[ch] || "";
  const midy = y + h / 2;
  const g = t * 0.3;
  const sh = (px, py) => [px + (y + h - py) * slant, py]; // shear x by height above baseline
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const [sx, sy] = sh(p[0], p[1]);
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.fill();
  };
  const hbar = (cy) => poly([
    [x + g, cy], [x + g + t / 2, cy - t / 2], [x + w - g - t / 2, cy - t / 2],
    [x + w - g, cy], [x + w - g - t / 2, cy + t / 2], [x + g + t / 2, cy + t / 2],
  ]);
  const vbar = (cx, y0, y1) => poly([
    [cx, y0 + g], [cx + t / 2, y0 + g + t / 2], [cx + t / 2, y1 - g - t / 2],
    [cx, y1 - g], [cx - t / 2, y1 - g - t / 2], [cx - t / 2, y0 + g + t / 2],
  ]);
  if (segs.includes("a")) hbar(y);
  if (segs.includes("g")) hbar(midy);
  if (segs.includes("d")) hbar(y + h);
  if (segs.includes("f")) vbar(x, y, midy);
  if (segs.includes("b")) vbar(x + w, y, midy);
  if (segs.includes("e")) vbar(x, midy, y + h);
  if (segs.includes("c")) vbar(x + w, midy, y + h);
}

function drawSegApos(ctx, x, y, h, t, slant = DB_SLANT) {
  const sh = (px, py) => [px + (y + h - py) * slant, py];
  ctx.beginPath();
  [[x, y], [x + t, y], [x + t * 0.7, y + h * 0.28], [x - t * 0.3, y + h * 0.28]].forEach((p, i) => {
    const [sx, sy] = sh(p[0], p[1]);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fill();
}

// a decimal point (small square sitting on the baseline) — used by the LCD panel
function drawSegDot(ctx, x, y, h, t, slant = DB_SLANT) {
  const sh = (px, py) => [px + (y + h - py) * slant, py];
  const s = t * 1.3;
  const cxv = x + s / 2;
  const cyv = y + h - s / 2;
  const pts = [
    [cxv - s / 2, cyv - s / 2], [cxv + s / 2, cyv - s / 2],
    [cxv + s / 2, cyv + s / 2], [cxv - s / 2, cyv + s / 2],
  ];
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [sx, sy] = sh(p[0], p[1]);
    if (i === 0) ctx.moveTo(sx, sy);
    else ctx.lineTo(sx, sy);
  });
  ctx.closePath();
  ctx.fill();
}

// advance widths for a databack string (digits, spaces, apostrophe)
function segMeasure(chars, dh) {
  const dw = dh * 0.55, sep = dh * 0.26, grp = dh * 0.75, ap = dh * 0.22;
  const adv = [];
  for (const ch of chars) {
    if (ch === " ") adv.push(grp);
    else if (ch === "'") adv.push(ap);
    else if (ch === ".") adv.push(dh * 0.24);
    else adv.push(dw);
  }
  const total = adv.reduce((s, a) => s + a + sep, 0) - sep;
  return { total, adv, dw, sep };
}

// draw the whole databack string (fills current ctx.fillStyle)
function drawSegString(ctx, x, y, chars, dh, slant = DB_SLANT) {
  const { adv, dw, sep } = segMeasure(chars, dh);
  const t = Math.max(2, dh * 0.13);
  let cx = x;
  chars.split("").forEach((ch, i) => {
    if (ch >= "0" && ch <= "9") drawSegDigit(ctx, cx, y, dw, dh, ch, t, slant);
    else if (ch === "'") drawSegApos(ctx, cx, y, dh, t, slant);
    else if (ch === ".") drawSegDot(ctx, cx, y, dh, t, slant);
    cx += adv[i] + sep;
  });
}

// rounded-rect path helper (native roundRect when available, else manual arcs)
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------- LCD status panel (mimics a camera's small monochrome LCD) ----------
// Canon-style top LCD: warm amber reflective backlight with dark etched
// segments/labels, boxed indicators, a metering-circle icon and an
// exposure-comp scale. Uses real EXIF for shutter/aperture/ISO/focal/date;
// AWB, the metering ring and the scale needle are fixed decorative signifiers.
function drawLcdPanel(ctx, canvasW, canvasH, drawW, exif) {
  if (!exif) return;

  const apt = exif.FNumber != null ? exif.FNumber.toFixed(1) : null;
  const iso = exif.ISO != null ? String(exif.ISO) : null;
  const focal = exif.FocalLength != null ? String(Math.round(exif.FocalLength)) : null;
  const date = fmtDatabackDate(exif.DateTimeOriginal);
  const et = exif.ExposureTime;
  let shut = null, shutSuf = "";
  if (et != null && et > 0) {
    if (et < 1) shut = String(Math.round(1 / et)); // Canon shows the denominator
    else { shut = et % 1 === 0 ? String(et) : et.toFixed(1); shutSuf = '"'; }
  }

  // geometry (panel ~half the image width, sitting bottom-left)
  const Pw = Math.round(drawW * 0.5);
  const bezel = Math.max(4, Math.round(Pw * 0.02));
  const pad = Math.round(Pw * 0.055);
  const ix = 0, iw = Pw - (bezel + pad) * 2; // content coords are panel-relative below

  const dhShut = Math.round(Pw * 0.17);
  const dhApt = Math.round(Pw * 0.135);
  const dhIso = Math.round(Pw * 0.115);
  const dhDate = Math.round(Pw * 0.07);
  const smLab = Math.round(Pw * 0.05);
  const hInd = Math.round(dhShut * 0.42);
  const hScale = Math.round(Pw * 0.055);
  const g = Math.round(Pw * 0.04);

  const contentH = hInd + g + dhShut + g + dhIso + g + hScale + g + dhDate;
  const Ph = contentH + (bezel + pad) * 2;

  const inset = Math.round(drawW * 0.045);
  const px = inset;
  const py = canvasH - inset - Ph;

  // bezel
  roundRectPath(ctx, px, py, Pw, Ph, bezel * 1.6);
  ctx.fillStyle = "#17150f";
  ctx.fill();
  // amber backlight
  const bx = px + bezel, by = py + bezel, bw = Pw - bezel * 2, bh = Ph - bezel * 2;
  const grad = ctx.createLinearGradient(0, by, 0, by + bh);
  grad.addColorStop(0, "#d3c294");
  grad.addColorStop(0.55, "#c3b17f");
  grad.addColorStop(1, "#ab9865");
  roundRectPath(ctx, bx, by, bw, bh, bezel);
  ctx.fillStyle = grad;
  ctx.fill();

  const ink = "rgba(52,47,33,0.92)";
  const ox = px + bezel + pad; // content origin x
  const oy = py + bezel + pad; // content origin y
  const right = ox + iw;

  // --- helpers (panel-local) ---
  const seg = (x, y, dh, str, align = "left", ghost = true) => {
    const w = segMeasure(str, dh).total;
    const sx = align === "right" ? x - w : x;
    if (ghost) {
      ctx.save();
      ctx.globalAlpha = 0.09;
      ctx.fillStyle = ink;
      drawSegString(ctx, sx, y, str.replace(/[0-9]/g, "8"), dh, 0);
      ctx.restore();
    }
    ctx.fillStyle = ink;
    drawSegString(ctx, sx, y, str, dh, 0);
    return w;
  };
  const txt = (x, y, s, size, align = "left", baseline = "alphabetic") => {
    ctx.font = `700 ${size}px "Courier New", monospace`;
    ctx.fillStyle = ink;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(s, x, y);
    const w = ctx.measureText(s).width;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    return w;
  };
  const box = (x, y, s, size) => {
    ctx.font = `700 ${size}px "Courier New", monospace`;
    const tw = ctx.measureText(s).width;
    const padx = size * 0.4, pady = size * 0.3;
    const w = tw + padx * 2, h = size + pady * 2;
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.strokeStyle = ink;
    roundRectPath(ctx, x, y, w, h, size * 0.28);
    ctx.stroke();
    txt(x + padx, y + h / 2, s, size, "left", "middle");
    return { w, h };
  };

  // --- indicator row: AWB box (left) + metering-circle icon (right) ---
  box(ox, oy, "AWB", smLab);
  const mr = hInd * 0.5;
  const mcx = right - mr, mcy = oy + hInd * 0.5;
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1.5, mr * 0.16);
  ctx.beginPath(); ctx.arc(mcx, mcy, mr, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = ink;
  ctx.beginPath(); ctx.arc(mcx, mcy, mr * 0.42, 0, Math.PI * 2); ctx.fill();
  // partial inner ring to echo Canon's center-weighted mark
  ctx.beginPath(); ctx.arc(mcx, mcy, mr * 0.66, -0.4, Math.PI * 0.9); ctx.stroke();

  // --- big row: shutter (left), aperture (right) ---
  const yBig = oy + hInd + g;
  const baseBig = yBig + dhShut;
  let cx = ox;
  if (shut) {
    cx += seg(cx, yBig, dhShut, shut);
    if (shutSuf) txt(cx + smLab * 0.2, baseBig, shutSuf, smLab * 1.3);
  }
  if (apt) {
    const aptW = segMeasure(apt, dhApt).total;
    const aptX = right - aptW;
    seg(aptX, baseBig - dhApt, dhApt, apt);
    txt(aptX - smLab * 0.3, baseBig, "F", smLab * 1.15, "right");
  }

  // --- ISO row: ISO value (left), focal length (right) ---
  const yIso = yBig + dhShut + g;
  const baseIso = yIso + dhIso;
  if (iso) {
    const lw = txt(ox, baseIso, "ISO", smLab, "left");
    seg(ox + lw + smLab * 0.5, yIso, dhIso, iso);
  }
  if (focal) {
    const mmW = txt(right, baseIso, "mm", smLab, "right");
    seg(right - mmW - smLab * 0.4, baseIso - dhIso, dhIso, focal, "right");
  }

  // --- exposure-comp scale (decorative): -3 . . 2 . . 1 . . 0 . . 1 . . 2 . . 3 ---
  const yScale = yIso + dhIso + g + hScale * 0.5;
  const n = 13; // 6 stops * 2 + center
  const step = iw / (n - 1);
  ctx.fillStyle = ink;
  for (let i = 0; i < n; i++) {
    const dx = ox + i * step;
    const major = i % 2 === 0;
    const r = major ? Math.max(1.5, hScale * 0.1) : Math.max(1, hScale * 0.06);
    ctx.beginPath(); ctx.arc(dx, yScale, r, 0, Math.PI * 2); ctx.fill();
  }
  txt(ox, yScale + hScale * 0.95, "-3", smLab * 0.8, "left");
  txt(right, yScale + hScale * 0.95, "+3", smLab * 0.8, "right");
  // needle at center (0 EV)
  const ncx = ox + iw / 2;
  ctx.fillRect(ncx - Math.max(1.5, hScale * 0.08), yScale - hScale * 0.55, Math.max(3, hScale * 0.16), hScale * 1.1);

  // --- date row ---
  const yDate = yScale + hScale * 0.5 + g;
  if (date) seg(ox, yDate, dhDate, date, "left", false);
}

// EXIF "YYYY:MM:DD ..." -> "'YY MM DD" databack format
function fmtDatabackDate(v) {
  if (!v) return null;
  const m = v.match(/(\d{4}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return `'${m[1].slice(2)} ${m[2]} ${m[3]}`;
}

function cameraNameOf(exif) {
  const make = (exif?.Make || "").trim();
  const model = (exif?.Model || "").trim();
  if (make && model) return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
  return make || model || "";
}

// ---------- 35mm film-strip frame ----------
// Dark film base with sprocket-hole rows top & bottom and orange film
// edge-printing (camera / frame no. / settings / date) in the inner lanes.
function drawFilmStrip(ctx, canvas, drawW, drawH, imgEl, exif, fields, caption) {
  const borderX = Math.round(drawW * 0.04);
  const bandH = Math.round(drawW * 0.12);
  const canvasW = drawW + borderX * 2;
  const canvasH = drawH + bandH * 2;
  canvas.width = canvasW;
  canvas.height = canvasH;

  // film base + photo
  ctx.fillStyle = "#141009";
  ctx.fillRect(0, 0, canvasW, canvasH);
  ctx.drawImage(imgEl, borderX, bandH, drawW, drawH);

  // sprocket holes fill the outer part of each band; the inner "lane"
  // (adjacent to the photo) is reserved for edge printing.
  const laneH = Math.round(bandH * 0.42);
  const holeW = Math.round(bandH * 0.5);
  const holeH = Math.round(bandH * 0.34);
  const holeR = holeH * 0.28;
  const gap = Math.round(holeW * 0.75);
  const pitch = holeW + gap;
  const nHoles = Math.max(1, Math.floor((canvasW + gap) / pitch));
  const totalW = nHoles * pitch - gap;
  const startX = Math.round((canvasW - totalW) / 2);
  const sprocketBox = bandH - laneH;
  const topHoleY = Math.round((sprocketBox - holeH) / 2);
  const botHoleY = Math.round(bandH + drawH + laneH + (sprocketBox - holeH) / 2);
  ctx.fillStyle = "#d8d2c1";
  for (let i = 0; i < nHoles; i++) {
    const hx = startX + i * pitch;
    roundRectPath(ctx, hx, topHoleY, holeW, holeH, holeR);
    ctx.fill();
    roundRectPath(ctx, hx, botHoleY, holeW, holeH, holeR);
    ctx.fill();
  }

  // orange edge printing
  const orange = "#e0862b";
  const fs = Math.max(11, Math.round(drawW * 0.019));
  const pad = borderX + Math.round(drawW * 0.012);
  ctx.fillStyle = orange;
  ctx.font = `700 ${fs}px "Courier New", monospace`;
  ctx.textBaseline = "alphabetic";

  // TOP lane: camera model (left) + frame number (right)
  const topBase = bandH - Math.round(laneH * 0.3);
  const cam = cameraNameOf(exif);
  ctx.textAlign = "left";
  if (fields.camera && cam) ctx.fillText(cam.toUpperCase(), pad, topBase);
  ctx.textAlign = "right";
  ctx.fillText("▶ 24A", canvasW - pad, topBase);

  // BOTTOM lane: settings (left) + date (right)
  const botBase = bandH + drawH + Math.round(laneH * 0.72);
  ctx.textAlign = "left";
  if (fields.settings && exif) {
    const parts = [fmtFocal(exif.FocalLength), fmtFNumber(exif.FNumber), fmtExposure(exif.ExposureTime), fmtISO(exif.ISO)].filter(Boolean);
    if (parts.length) ctx.fillText(parts.join("  "), pad, botBase);
  }
  ctx.textAlign = "right";
  const dstr = fields.date ? fmtDatabackDate(exif?.DateTimeOriginal) : null;
  if (dstr) ctx.fillText(dstr, canvasW - pad, botBase);
  else if (caption?.trim()) ctx.fillText(caption.trim().toUpperCase(), canvasW - pad, botBase);

  ctx.textAlign = "left";
}

export default function ExifFrameApp() {
  const [imgEl, setImgEl] = useState(null);
  const [exif, setExif] = useState(null);
  const [frameStyle, setFrameStyle] = useState("film");
  const [caption, setCaption] = useState("");
  const [fields, setFields] = useState({
    camera: true,
    lens: true,
    settings: true,
    date: true,
  });
  const [error, setError] = useState(null);
  const [fileName, setFileName] = useState("");
  const canvasRef = useRef(null);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setError(null);
    setFileName(file.name.replace(/\.[^.]+$/, ""));

    // HEIC/HEIF can't be decoded or EXIF-read by browsers. Detect early and
    // guide the user, since converting would strip the EXIF date we need.
    const isHeic =
      /\.(heic|heif)$/i.test(file.name) ||
      file.type === "image/heic" ||
      file.type === "image/heif";
    if (isHeic) {
      setError(
        "HEIC 사진은 브라우저에서 열 수 없어요. 아이폰이라면 설정 › 카메라 › 포맷에서 '높은 호환성(JPEG)'으로 바꾸거나, 사진을 JPG로 저장해 다시 올려주세요. (HEIC를 변환하면 촬영 날짜 정보가 사라져 데이터백에 쓸 수 없어요.)"
      );
      return;
    }

    // 1) Read raw bytes and parse EXIF from the ORIGINAL file (before any
    //    re-encoding, so the shooting date survives even for MPO/large files).
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (err) {
      setError("파일을 읽을 수 없어요.");
      return;
    }
    let parsed = null;
    try {
      parsed = parseExif(buf);
    } catch (err) {
      parsed = null;
    }

    // 2) Decode robustly. createImageBitmap handles MPO and very large files
    //    more reliably than <img>, especially on mobile. Fall back to <img>.
    //    imageOrientation:"from-image" lets the browser bake the EXIF
    //    orientation into the pixels, so decoded dimensions are already
    //    upright and we never rotate manually (avoids double-rotation). The
    //    <img> fallback auto-applies orientation the same way by default.
    let srcW = 0, srcH = 0, drawable = null;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      srcW = bitmap.width;
      srcH = bitmap.height;
      drawable = bitmap;
    } catch (err) {
      // fallback: <img> via object URL
      try {
        drawable = await new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const im = new Image();
          im.onload = () => {
            URL.revokeObjectURL(url);
            resolve(im);
          };
          im.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("decode failed"));
          };
          im.src = url;
        });
        srcW = drawable.naturalWidth;
        srcH = drawable.naturalHeight;
      } catch (err2) {
        setError(
          "이 사진을 열 수 없어요. 카메라 원본이 MPO 형식이거나 파일이 손상됐을 수 있어요. 사진을 한 번 다른 앱(갤러리/사진)에서 열어 JPG로 다시 저장한 뒤 올려보세요."
        );
        return;
      }
    }

    if (!srcW || !srcH) {
      setError("사진 크기를 읽지 못했어요. 다른 사진으로 시도해주세요.");
      return;
    }

    // 3) Downscale to a mobile-safe canvas limit. iOS Safari caps canvas area
    //    (~16.7MP) and max side ~4096px, so a 22MP camera JPEG must shrink.
    const MAX_SIDE = 3600; // safely under mobile limits, plenty for stories
    const scale = Math.min(1, MAX_SIDE / Math.max(srcW, srcH));
    const outW = Math.round(srcW * scale);
    const outH = Math.round(srcH * scale);

    // 4) Normalize into a clean standard JPEG <img>, so the rest of the app
    //    (which relies on naturalWidth + drawImage) works identically.
    try {
      const tmp = document.createElement("canvas");
      tmp.width = outW;
      tmp.height = outH;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(drawable, 0, 0, outW, outH);
      if (drawable.close) drawable.close(); // free ImageBitmap memory

      const dataUrl = tmp.toDataURL("image/jpeg", 0.92);
      const finalImg = new Image();
      finalImg.onload = () => {
        setExif(parsed);
        setError(null);
        setImgEl(finalImg);
      };
      finalImg.onerror = () => setError("이미지를 준비하는 중 문제가 생겼어요. 다시 시도해주세요.");
      finalImg.src = dataUrl;
    } catch (err) {
      setError(
        "사진이 너무 커서 이 기기에서 처리할 수 없어요. 사진 크기를 줄여서(예: 화면 캡처나 리사이즈) 다시 올려주세요."
      );
    }
  }, []);

  const onDrop = (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imgEl) return;
    const ctx = canvas.getContext("2d");
    const style = STYLES[frameStyle];

    // Pixels are already upright (orientation baked in at decode time), so the
    // frame just uses the image's own dimensions — no rotation needed here.
    const drawW = imgEl.naturalWidth;
    const drawH = imgEl.naturalHeight;

    // film uses its own strip geometry (sprocket bands top & bottom)
    if (frameStyle === "film") {
      drawFilmStrip(ctx, canvas, drawW, drawH, imgEl, exif, fields, caption);
      return;
    }

    const border = style.border;
    const bottomExtra = style.bottomExtra;
    const canvasW = drawW + border * 2;
    const canvasH = drawH + border * 2 + bottomExtra;
    canvas.width = canvasW;
    canvas.height = canvasH;

    // background
    if (style.bg) {
      ctx.fillStyle = style.bg;
      ctx.fillRect(0, 0, canvasW, canvasH);
    }

    // draw the image into the frame area
    ctx.drawImage(imgEl, border, border, drawW, drawH);

    // build text lines from enabled fields
    const lines = [];
    if (fields.camera && exif && (exif.Make || exif.Model)) {
      const make = (exif.Make || "").trim();
      const model = (exif.Model || "").trim();
      let cameraName;
      if (make && model) {
        cameraName = model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
      } else {
        cameraName = make || model;
      }
      if (cameraName) lines.push(cameraName.toUpperCase());
    }
    if (fields.lens && exif?.LensModel) {
      lines.push(exif.LensModel);
    }
    if (fields.settings && exif) {
      const parts = [fmtFocal(exif.FocalLength), fmtFNumber(exif.FNumber), fmtExposure(exif.ExposureTime), fmtISO(exif.ISO)].filter(Boolean);
      if (parts.length) lines.push(parts.join("  ·  "));
    }
    if (fields.date && exif?.DateTimeOriginal) {
      lines.push(fmtDate(exif.DateTimeOriginal));
    }
    if (caption.trim()) lines.push(caption.trim().toUpperCase());

    if (frameStyle === "databack") {
      // authentic film databack: '26-format date, 7-segment italic glyphs,
      // deep orange light burned into the frame (additive glow, no shadow)
      const dstr = fmtDatabackDate(exif?.DateTimeOriginal);
      if (dstr) {
        const dh = Math.max(12, Math.round(drawW * 0.024)); // small
        const pad = Math.round(drawW * 0.085); // inset from edge
        const { total } = segMeasure(dstr, dh);
        const x0 = canvasW - pad - total;
        const y0 = canvasH - pad - dh;

        // render the stamp shape once on an offscreen canvas (white on transparent)
        const stamp = document.createElement("canvas");
        stamp.width = canvasW;
        stamp.height = canvasH;
        const sctx = stamp.getContext("2d");
        sctx.fillStyle = "#ffffff";
        drawSegString(sctx, x0, y0, dstr, dh);

        // tint the white stamp shape with `color`, optionally blurred, and
        // paint it onto ctx using the current composite mode.
        const drawTinted = (color, blur) => {
          const tinted = document.createElement("canvas");
          tinted.width = canvasW;
          tinted.height = canvasH;
          const tctx = tinted.getContext("2d");
          tctx.drawImage(stamp, 0, 0);
          tctx.globalCompositeOperation = "source-in";
          tctx.fillStyle = color;
          tctx.fillRect(0, 0, canvasW, canvasH);
          ctx.save();
          ctx.filter = blur > 0 ? `blur(${blur}px)` : "none";
          ctx.drawImage(tinted, 0, 0);
          ctx.restore();
        };

        // Halos: additive ("lighter") so they read as burned light on dark
        // scenes. On bright scenes they add little — harmless.
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        drawTinted("rgba(255,74,18,0.45)", dh * 0.5); // wide soft halo
        drawTinted("rgba(255,74,18,0.75)", dh * 0.14); // tight halo
        ctx.restore();

        // Hot core: normal compositing with a solid orange-red so the date
        // always reads as orange-red. (Pure additive clips to white on bright
        // backgrounds, which is what made the stamp look white.)
        drawTinted("rgb(255,78,28)", 0);
      }
    } else if (frameStyle === "lcd") {
      // small camera-style LCD status panel overlaid on the image
      drawLcdPanel(ctx, canvasW, canvasH, drawW, exif);
    } else {
      // text block in the bottom area (below the image)
      const fontSize = Math.max(14, Math.round(drawW * 0.02));
      const labelFontSize = Math.max(11, Math.round(fontSize * 0.62));
      let y = border + drawH + fontSize * 1.4;

      ctx.textAlign = "left";
      lines.forEach((line, idx) => {
        ctx.font = idx === 0 ? `700 ${fontSize}px "Courier New", monospace` : `400 ${labelFontSize + 2}px "Courier New", monospace`;
        ctx.fillStyle = idx === 0 ? style.textColor : style.labelColor;
        ctx.fillText(line, border, y);
        y += (idx === 0 ? fontSize : labelFontSize + 2) * 1.5;
      });
    }
  }, [imgEl, exif, frameStyle, fields, caption]);

  useEffect(() => {
    draw();
  }, [draw]);

  const handleDownload = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const filename = `${fileName || "photo"}_framed.png`;

    // toBlob can return null on mobile if the canvas is too large / low memory.
    canvas.toBlob((blob) => {
      if (!blob) {
        // fallback: try a data URL directly
        try {
          triggerDownload(canvas.toDataURL("image/png"), filename);
        } catch (err) {
          setError(
            "이미지를 저장용으로 만드는 데 실패했어요. 사진이 너무 큰 것 같아요. 다른 사진으로 시도하거나, 화면을 캡처해 저장해주세요."
          );
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      // revoke later so the browser has time to start the download
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }, "image/png");
  };

  const triggerDownload = (url, filename) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const exifRows = exif
    ? [
        { icon: Camera, label: "Camera", value: (() => {
            const make = (exif.Make || "").trim();
            const model = (exif.Model || "").trim();
            if (make && model) return model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`;
            return make || model || "—";
          })() },
        { icon: Aperture, label: "Lens", value: exif.LensModel || "—" },
        {
          icon: Gauge,
          label: "Settings",
          value: [fmtFocal(exif.FocalLength), fmtFNumber(exif.FNumber), fmtExposure(exif.ExposureTime), fmtISO(exif.ISO)].filter(Boolean).join(" · ") || "—",
        },
        { icon: Clock, label: "Date", value: fmtDate(exif.DateTimeOriginal) || "—" },
      ]
    : [];

  return (
    <div style={{ minHeight: "100vh", background: "#141210", color: "#e8e2d5", fontFamily: "'Courier New', monospace", padding: "24px 16px" }}>
      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, letterSpacing: 3, color: "#8a8577", marginBottom: 4 }}>EXIF · FRAME · TOOL</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>사진에서 촬영 정보를 꺼내 프레임을 태우세요</h1>
        </div>

        {/* upload zone */}
        {!imgEl && (
          <label
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              border: "1px dashed #4a453d",
              borderRadius: 4,
              padding: "48px 16px",
              cursor: "pointer",
              color: "#8a8577",
            }}
          >
            <Upload size={22} strokeWidth={1.5} />
            <span style={{ fontSize: 13 }}>탭하거나 사진을 끌어다 놓으세요 (JPEG · PNG)</span>
            <input type="file" accept="image/jpeg,image/jpg,image/png,image/*" style={{ display: "none" }} onChange={(e) => handleFile(e.target.files?.[0])} />
          </label>
        )}

        {error && <div style={{ color: "#e05b3a", fontSize: 13, lineHeight: 1.5, marginTop: 10, padding: "10px 12px", background: "#241614", borderRadius: 4 }}>{error}</div>}

        {imgEl && (
          <>
            {/* canvas preview */}
            <div style={{ border: "1px solid #2b2824", borderRadius: 4, overflow: "hidden", marginBottom: 16 }}>
              <canvas ref={canvasRef} style={{ width: "100%", display: "block", background: "#0d0c0a" }} />
            </div>

            {/* exif readout */}
            <div style={{ background: "#1c1a17", borderRadius: 4, padding: 14, marginBottom: 16, fontSize: 12 }}>
              {exif ? (
                exifRows.map((r) => (
                  <div key={r.label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", color: "#c9c3b4" }}>
                    <span style={{ color: "#8a8577" }}>{r.label}</span>
                    <span>{r.value}</span>
                  </div>
                ))
              ) : (
                <div style={{ color: "#8a8577" }}>이 파일에서 EXIF 정보를 찾지 못했어요. (편집/캡처된 이미지이거나 정보가 제거됐을 수 있어요)</div>
              )}
            </div>

            {/* frame style picker */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: "#8a8577", marginBottom: 8 }}>FRAME STYLE</div>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.entries(STYLES).map(([key, s]) => (
                  <button
                    key={key}
                    onClick={() => setFrameStyle(key)}
                    style={{
                      flex: 1,
                      padding: "10px 6px",
                      fontSize: 12,
                      borderRadius: 4,
                      border: frameStyle === key ? "1px solid #c4581f" : "1px solid #2b2824",
                      background: frameStyle === key ? "#2b2416" : "transparent",
                      color: frameStyle === key ? "#c4581f" : "#8a8577",
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* field toggles */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: "#8a8577", marginBottom: 8 }}>SHOW FIELDS</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {Object.entries({ camera: "Camera", lens: "Lens", settings: "Settings", date: "Date" }).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFields((f) => ({ ...f, [key]: !f[key] }))}
                    style={{
                      padding: "6px 12px",
                      fontSize: 11,
                      borderRadius: 20,
                      border: "1px solid " + (fields[key] ? "#c4581f" : "#2b2824"),
                      background: fields[key] ? "#2b2416" : "transparent",
                      color: fields[key] ? "#c4581f" : "#8a8577",
                      cursor: "pointer",
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* caption */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, letterSpacing: 2, color: "#8a8577", marginBottom: 8 }}>CAPTION (선택)</div>
              <input
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="예: COSTA DE CAPARICA, PT"
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "10px 12px",
                  fontSize: 13,
                  fontFamily: "'Courier New', monospace",
                  borderRadius: 4,
                  border: "1px solid #2b2824",
                  background: "#1c1a17",
                  color: "#e8e2d5",
                }}
              />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={handleDownload}
                style={{
                  flex: 1,
                  padding: "12px",
                  fontSize: 13,
                  fontWeight: 700,
                  borderRadius: 4,
                  border: "none",
                  background: "#c4581f",
                  color: "#141210",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 6,
                }}
              >
                <Download size={15} /> PNG 저장
              </button>
              <button
                onClick={() => {
                  setImgEl(null);
                  setExif(null);
                  setCaption("");
                }}
                style={{
                  padding: "12px 16px",
                  fontSize: 13,
                  borderRadius: 4,
                  border: "1px solid #2b2824",
                  background: "transparent",
                  color: "#8a8577",
                  cursor: "pointer",
                }}
              >
                다시 선택
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
