'use strict';
/*
 * NSOFT N-MES — 15s motion graphic.
 * Every frame is a pure function of time t (seconds), so the renderer can
 * sample any instant (sub-frames for motion blur, parallel workers).
 * Timeline is locked to a 128 BPM grid: 32 beats = 8 bars = 15.000s.
 */
(function () {
const W = 1920, H = 1080, BPM = 128, BEAT = 60 / BPM, DUR = 15, FPS = 60;
const COL = {
  bg: '#040914', ink: '#040914', navy: '#0C254B', deep: '#071634', card: '#0A1A3A',
  blue: '#3197EF', blueHi: '#6CC0FF', cyan: '#48E5FF', white: '#F4F8FF', mute: '#8CA3C9', hot: '#FF5A36',
};
const cv = document.getElementById('c');
const ctx = cv.getContext('2d', { willReadFrequently: true });

// ---------------------------------------------------------------- utils
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (x, a, b) => clamp((x - a) / (b - a));
const frac = x => x - Math.floor(x);
const E = {
  outExpo: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  inExpo: t => t <= 0 ? 0 : Math.pow(2, 10 * t - 10),
  inOutExpo: t => t <= 0 ? 0 : t >= 1 ? 1 : t < .5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
  outCubic: t => 1 - Math.pow(1 - t, 3),
  inCubic: t => t * t * t,
  inOutCubic: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
  outQuart: t => 1 - Math.pow(1 - t, 4),
  outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
};
function rng(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const F = (fam, size, w = '') => `${w} ${size}px ${fam}`.trim();
function text(s, x, y, o = {}) {
  ctx.save();
  ctx.font = F(o.f || 'BHS', o.size || 100, o.w || '');
  ctx.fillStyle = o.color || COL.white;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.base || 'alphabetic';
  ctx.letterSpacing = (o.ls || 0) + 'px';
  if (o.alpha !== undefined) ctx.globalAlpha *= o.alpha;
  ctx.fillText(s, x, y);
  ctx.restore();
}
function tw(s, font, ls = 0) { ctx.save(); ctx.font = font; ctx.letterSpacing = ls + 'px'; const w = ctx.measureText(s).width - ls; ctx.restore(); return w; }
function rrect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`;
}

// ------------------------------------------------ rhythm / global events
// kicks mirror the soundtrack (audio.py) so every visual hit lands on a drum hit
const KICKS = [0, 1, 2]; for (let b = 4; b <= 27; b++) KICKS.push(b); KICKS.push(28);
const IMPACTS = [ // [beat, strength] -> camera shake + chromatic split
  [0, .9], [1, .9], [2, 1.1], [4, .7], [8, 1.4], [12, .5], [13, .5], [14, .5], [15, .6],
  [20, .5], [24, .8], [25, .8], [26, .8], [27, .9], [27.5, .6], [27.625, .7], [27.75, .8], [27.875, 1], [28, 1.8],
];
function kickEnv(bt) {
  let best = 0;
  for (const k of KICKS) { const d = bt - k; if (d >= 0 && d < 1) best = Math.max(best, Math.exp(-d * 9)); }
  return best;
}
function impactEnv(bt, decay = 7) {
  let s = 0;
  for (const [b, a] of IMPACTS) { const d = bt - b; if (d >= 0 && d < 1.5) s += a * Math.exp(-d * decay); }
  return s;
}
function shake(bt) {
  const a = impactEnv(bt, 9) * 14;
  return { x: a * Math.sin(bt * 91.7) * Math.cos(bt * 13.1), y: a * Math.sin(bt * 77.3 + 1.3) };
}

// ------------------------------------------------------------ assets
let P = null;          // particle system
let WORD3 = null, WORD8 = null, BARS = null, CALLOUTS = null;
let grainTiles = [], vignette = null, bloomCv = null, bloomCtx = null, tmpCv = null, tmpCtx = null;
let S1 = null;         // scene-1 layout metrics

function makeWord(parts, font, pad = 40) {
  const m = document.createElement('canvas').getContext('2d');
  m.font = font;
  let total = 0;
  const ws = parts.map(p => { const w = m.measureText(p.s).width; total += w; return w; });
  const met = m.measureText(parts.map(p => p.s).join(''));
  const asc = Math.ceil(met.actualBoundingBoxAscent), desc = Math.ceil(met.actualBoundingBoxDescent);
  const c = document.createElement('canvas');
  c.width = Math.ceil(total + pad * 2); c.height = asc + desc + pad * 2;
  const o = c.getContext('2d');
  o.font = font; o.textBaseline = 'alphabetic';
  let x = pad; const offs = [];
  parts.forEach((p, i) => { o.fillStyle = p.c; o.fillText(p.s, x, pad + asc); offs.push(x); x += ws[i]; });
  return { c, w: c.width, h: c.height, asc, desc, pad, offs, ws };
}

function sampleText(lines, step) {
  const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
  const o = oc.getContext('2d', { willReadFrequently: true });
  o.fillStyle = '#fff';
  lines.forEach(L => { o.font = F(L.f || 'BHS', L.size); o.textAlign = L.align || 'left'; o.fillText(L.s, L.x, L.y); });
  const d = o.getImageData(0, 0, W, H).data, pts = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
    if (d[(y * W + x) * 4 + 3] > 140) pts.push([x, y, lines.findIndex(L => y <= L.y + 40 && y >= L.y - L.size)]);
  }
  return pts;
}

function init() {
  // ---- scene 1 layout
  ctx.font = F('BHS', 250);
  const m1 = ctx.measureText('현장의'), m2 = ctx.measureText('모든 순간을');
  S1 = {
    x: 150, y1: 470, y2: 790, size: 250, w1: m1.width, w2: m2.width,
    asc: m2.actualBoundingBoxAscent, desc: m2.actualBoundingBoxDescent,
  };
  // ---- particles: "현장의 모든 순간을" -> "데이터로."
  const src = sampleText([{ s: '현장의', x: S1.x, y: S1.y1, size: 250 }, { s: '모든 순간을', x: S1.x, y: S1.y2, size: 250 }], 9);
  const dst = sampleText([{ s: '데이터로.', x: 960, y: 650, size: 330, align: 'center' }], 10);
  src.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  dst.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = dst.length, r = rng(1234);
  P = { n, sx: new Float32Array(n), sy: new Float32Array(n), sl: new Int8Array(n), dx: new Float32Array(n), dy: new Float32Array(n), r1: new Float32Array(n), r2: new Float32Array(n), r3: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const s = src[Math.floor(i * src.length / n)];
    P.sx[i] = s[0]; P.sy[i] = s[1]; P.sl[i] = s[2];
    P.dx[i] = dst[i][0]; P.dy[i] = dst[i][1];
    P.r1[i] = r(); P.r2[i] = r(); P.r3[i] = r();
  }
  const near = (x, y) => { let bi = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = (P.dx[i] - x) ** 2 + (P.dy[i] - y) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; };
  CALLOUTS = [
    { a: near(420, 470), lx: 170, ly: 250, k: '설비온도', v: b => (182.4 + Math.sin(b * 7) * 1.3).toFixed(1) + '°C', t: 4.5 },
    { a: near(1260, 450), lx: 1330, ly: 250, k: '사이클타임', v: b => (42.1 + Math.sin(b * 5 + 1) * .6).toFixed(1) + 's', t: 5.0 },
    { a: near(700, 600), lx: 300, ly: 800, k: '생산수량', v: b => Math.floor(1200 + b * 12).toLocaleString('en-US') + ' EA', t: 5.5 },
    { a: near(1560, 600), lx: 1420, ly: 800, k: 'LOT', v: () => 'A-0417', t: 6.0 },
  ];
  // ---- words
  WORD3 = makeWord([{ s: 'N', c: COL.white }, { s: '-', c: COL.white }, { s: 'MES', c: COL.white }], F('ARC', 400), 30);
  WORD8 = makeWord([{ s: 'N', c: COL.blue }, { s: '-MES', c: COL.white }], F('ARC', 230), 30);
  // ---- barcode
  const rb = rng(2609); BARS = []; let u = 0;
  const push = (w, bar) => { if (bar) BARS.push([u, w]); u += w; };
  push(1, 1); push(1, 0); push(1, 1); push(1, 0);
  while (u < 128) { const w = 1 + Math.floor(rb() * 4), g = 1 + Math.floor(rb() * 3); push(w, 1); push(g, 0); }
  push(1, 1); push(1, 0); push(1, 1);
  BARS.units = u;
  // ---- post-processing buffers
  for (let k = 0; k < 4; k++) {
    const g = document.createElement('canvas'); g.width = g.height = 256;
    const gc = g.getContext('2d'), id = gc.createImageData(256, 256), rg = rng(99 + k);
    for (let i = 0; i < id.data.length; i += 4) { const v = rg() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    gc.putImageData(id, 0, 0); grainTiles.push(g);
  }
  vignette = document.createElement('canvas'); vignette.width = W; vignette.height = H;
  const vc = vignette.getContext('2d'), vg = vc.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, H * 1.05);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  vc.fillStyle = vg; vc.fillRect(0, 0, W, H);
  bloomCv = document.createElement('canvas'); bloomCv.width = W / 4; bloomCv.height = H / 4;
  bloomCtx = bloomCv.getContext('2d', { willReadFrequently: true });
  tmpCv = document.createElement('canvas'); tmpCv.width = W; tmpCv.height = H;
  tmpCtx = tmpCv.getContext('2d', { willReadFrequently: true });
}

// ================================================================ HUD
const SECTIONS = ['FIELD', 'DATA', 'N-MES', '4M', 'MONITORING', 'LOT TRACE', 'FLOW', 'NSOFT'];
function hud(bt) {
  const light = bt >= 25 && bt < 26;
  const c = light ? COL.navy : COL.white;
  const a = seg(bt, 0.05, 0.5) * (bt > 28 ? 1 - seg(bt, 28, 28.6) * .6 : 1);
  if (a <= 0) return;
  ctx.save();
  ctx.globalAlpha = .6 * a; ctx.strokeStyle = c; ctx.lineWidth = 2;
  const m = 44, l = 34;
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, sx, sy]) => {
    ctx.beginPath(); ctx.moveTo(x, y + sy * l); ctx.lineTo(x, y); ctx.lineTo(x + sx * l, y); ctx.stroke();
  });
  ctx.globalAlpha = .85 * a;
  // live dot pulses with the kick
  const k = kickEnv(bt);
  ctx.fillStyle = COL.blue; ctx.beginPath(); ctx.arc(m + 30, m + 22, 6 + k * 3, 0, 7); ctx.fill();
  text('NSOFT  ·  N-MES', m + 46, m + 29, { f: 'JBM', w: 800, size: 19, ls: 4, color: c });
  const s = Math.max(0, bt * BEAT), sec = Math.floor(s), ff = Math.floor((s - sec) * 60);
  text(`00:${String(sec).padStart(2, '0')}:${String(ff).padStart(2, '0')}`, W - m - 30, m + 29, { f: 'JBM', w: 500, size: 19, ls: 3, color: c, align: 'right' });
  // section label
  const si = clamp(Math.floor(bt / 4), 0, 7);
  const sp = E.outExpo(seg(bt, si * 4, si * 4 + .5));
  ctx.save(); ctx.beginPath(); ctx.rect(m + 20, H - m - 50, 600, 40); ctx.clip();
  text(`0${si + 1}`, m + 30, H - m - 16 + (1 - sp) * 30, { f: 'JBM', w: 800, size: 19, color: COL.blue });
  text(SECTIONS[si], m + 74, H - m - 16 + (1 - sp) * 30, { f: 'JBM', w: 800, size: 19, ls: 5, color: c });
  ctx.restore();
  // 32-step beat ruler
  const x0 = W - m - 30 - 32 * 12;
  for (let i = 0; i < 32; i++) {
    const on = bt >= i;
    ctx.fillStyle = on ? (i % 4 === 0 ? COL.blue : c) : hexA(light ? COL.navy : COL.white, .18);
    ctx.fillRect(x0 + i * 12, H - m - 30 - (i % 4 === 0 ? 8 : 0), 6, i % 4 === 0 ? 20 : 12);
  }
  ctx.restore();
}

// ============================================================= SCENE 1
// "현장의 / 모든 순간을" — word slams, then a scanner digitises the text into dots
function scanX(bt) { return lerp(60, 1720, E.inOutCubic(seg(bt, 2.0, 2.8))); }
function scene1(bt) {
  if (bt >= 3.3) return;
  const sx = bt >= 2 ? scanX(bt) : -1;
  ctx.save();
  if (sx > 0) { ctx.beginPath(); ctx.rect(sx, 0, W - sx, H); ctx.clip(); }
  // right column editorial text
  const ed = seg(bt, .35, 1.2);
  if (ed > 0) {
    const s1 = 'EVERY MOMENT', s2 = 'ON THE FACTORY FLOOR';
    text(s1.slice(0, Math.ceil(s1.length * ed)), 1770, 250, { f: 'SG', w: 700, size: 26, ls: 8, color: COL.mute, align: 'right' });
    text(s2.slice(0, Math.ceil(s2.length * seg(bt, .6, 1.5))), 1770, 290, { f: 'SG', w: 700, size: 26, ls: 8, color: COL.mute, align: 'right' });
    ctx.fillStyle = COL.blue; ctx.fillRect(1770 - 60 * E.outExpo(seg(bt, .4, .9)), 205, 60 * E.outExpo(seg(bt, .4, .9)), 6);
  }
  // line 1
  if (bt >= 0) {
    const p = E.outExpo(seg(bt, 0, .45));
    const sc = lerp(1.45, 1, p);
    ctx.save();
    ctx.translate(S1.x, S1.y1); ctx.scale(sc, sc); ctx.translate(-S1.x, -S1.y1);
    text('현장의', S1.x, S1.y1 - (1 - p) * 60, { size: 250, color: COL.white });
    ctx.restore();
  }
  // line 2 on a blue slab
  if (bt >= 1) {
    const p = E.outExpo(seg(bt, 1, 1.35));
    const sw = (S1.w2 + 90) * p;
    ctx.fillStyle = COL.blue;
    ctx.fillRect(S1.x - 40, S1.y2 - S1.asc - 34, sw, S1.asc + S1.desc + 68);
    ctx.save();
    ctx.beginPath(); ctx.rect(S1.x - 40, 0, sw, H); ctx.clip();
    text('모든 순간을', S1.x + (1 - p) * -120, S1.y2, { size: 250, color: COL.ink });
    ctx.restore();
  }
  // number tag
  if (bt >= 1.2) text('01 — 현장', S1.x, S1.y1 - 230, { f: 'JBM', w: 800, size: 22, ls: 6, color: COL.blue, alpha: seg(bt, 1.2, 1.5) });
  ctx.restore();
  // scanner beam
  if (bt >= 2 && bt < 3.0) {
    const a = 1 - seg(bt, 2.75, 3.0);
    ctx.save();
    const g = ctx.createLinearGradient(sx - 260, 0, sx, 0);
    g.addColorStop(0, hexA(COL.cyan, 0)); g.addColorStop(1, hexA(COL.cyan, .28 * a));
    ctx.fillStyle = g; ctx.fillRect(sx - 260, 0, 260, H);
    ctx.fillStyle = hexA(COL.white, a); ctx.fillRect(sx - 2, 0, 4, H);
    ctx.shadowColor = COL.cyan; ctx.shadowBlur = 40; ctx.fillStyle = hexA(COL.cyan, a); ctx.fillRect(sx - 5, 0, 10, H);
    ctx.restore();
    text('DIGITIZING', sx + 18, 120, { f: 'JBM', w: 800, size: 18, ls: 6, color: COL.cyan, alpha: a });
    text(String(Math.round(seg(bt, 2, 2.8) * 100)).padStart(3, '0') + '%', sx + 18, 150, { f: 'JBM', w: 500, size: 18, ls: 4, color: COL.white, alpha: a });
  }
}

// ======================================================= PARTICLES 1 -> 2
function particles(bt) {
  if (bt < 2 || bt >= 8.02) return;
  const sxs = scanX(bt), cx = 960, cy = 540;
  for (let i = 0; i < P.n; i++) {
    const r1 = P.r1[i], r2 = P.r2[i], r3 = P.r3[i];
    const st = 2.95 + r1 * .3 + (P.sx[i] / W) * .1, en = st + .65;
    let x, y, s = 6.5, c = COL.white, a = 1;
    if (bt < st) {
      if (P.sx[i] > sxs) continue;
      const pop = E.outBack(clamp((sxs - P.sx[i]) / 160));
      x = P.sx[i]; y = P.sy[i]; s = 6.5 * pop;
      c = P.sl[i] === 1 ? COL.blue : COL.white;
      if (r3 > .9) c = COL.cyan;
      // tremble just before lift-off
      if (bt > 2.8) { x += Math.sin(bt * 60 + i) * 1.5; y += Math.cos(bt * 53 + i) * 1.5; }
    } else if (bt < en) {
      const p = E.inOutCubic(seg(bt, st, en));
      const ddx = P.dx[i] - P.sx[i], ddy = P.dy[i] - P.sy[i], L = Math.hypot(ddx, ddy) || 1;
      const arc = (r2 - .5) * 320 * Math.sin(Math.PI * p);
      x = lerp(P.sx[i], P.dx[i], p) - ddy / L * arc;
      y = lerp(P.sy[i], P.dy[i], p) + ddx / L * arc;
      s = 5; c = r3 > .5 ? COL.cyan : COL.blueHi;
    } else {
      x = P.dx[i]; y = P.dy[i];
      // kick ripple travelling out from the centre
      const ph = bt >= 4 ? frac(bt) : 0;
      const d = Math.hypot(x - cx, y - 560), wave = ph * 1500;
      const k = bt >= 4 ? Math.exp(-(((d - wave) / 100) ** 2)) * (1 - ph) : 0;
      s = 6.5 * (1 + 1.1 * k);
      c = k > .35 ? COL.cyan : (r3 > .93 && Math.sin(bt * 20 + i) > 0 ? COL.blue : COL.white);
      if (bt >= 7) {
        const q = E.inExpo(seg(bt, 7.0 + r1 * .25, 7.9));
        x = lerp(x, cx, q); y = lerp(y, cy, q); s = lerp(s, 3, q);
        if (q > .3) c = COL.cyan;
      }
    }
    ctx.fillStyle = c; ctx.globalAlpha = a;
    ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  // singularity before the N-MES bang
  if (bt > 7.55) {
    const g = E.inExpo(seg(bt, 7.55, 8.0));
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 30 + g * 260);
    rg.addColorStop(0, hexA(COL.white, 1)); rg.addColorStop(.25, hexA(COL.cyan, .8 * g)); rg.addColorStop(1, hexA(COL.blue, 0));
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

// ============================================================= SCENE 2
function floorGrid(bt, alpha, vpY = 600) {
  if (alpha <= 0) return;
  const vpX = 960;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.5;
  const g = ctx.createLinearGradient(0, vpY, 0, H);
  g.addColorStop(0, hexA(COL.blue, 0)); g.addColorStop(.25, hexA(COL.blue, .35)); g.addColorStop(1, hexA(COL.blue, .75));
  ctx.strokeStyle = g;
  ctx.beginPath();
  for (let j = -16; j <= 16; j++) { ctx.moveTo(vpX + j * 12, vpY); ctx.lineTo(vpX + j * 230, H + 40); }
  const off = frac(bt * 1.6);
  for (let k = 0; k < 26; k++) {
    const z = k + 1 - off; if (z < .6) continue;
    const y = vpY + 440 / z; if (y > H) continue;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  ctx.stroke();
  // horizon glow
  const hg = ctx.createLinearGradient(0, vpY - 40, 0, vpY + 40);
  hg.addColorStop(0, hexA(COL.blue, 0)); hg.addColorStop(.5, hexA(COL.blue, .5)); hg.addColorStop(1, hexA(COL.blue, 0));
  ctx.fillStyle = hg; ctx.fillRect(0, vpY - 40, W, 80);
  // light pulses running toward the viewer
  const r = rng(7);
  ctx.globalCompositeOperation = 'lighter';
  for (let m = 0; m < 14; m++) {
    const j = Math.floor(r() * 33) - 16, sp = .5 + r() * .8, ph = frac(bt * sp * .5 + r());
    const t0 = ph * ph, t1 = Math.min(1, t0 + .12);
    const x0 = lerp(vpX + j * 12, vpX + j * 230, t0), y0 = lerp(vpY, H + 40, t0);
    const x1 = lerp(vpX + j * 12, vpX + j * 230, t1), y1 = lerp(vpY, H + 40, t1);
    ctx.strokeStyle = hexA(COL.cyan, .9); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
  ctx.restore();
}
function scene2Back(bt) {
  if (bt < 3.6 || bt >= 8) return;
  const a = seg(bt, 3.7, 4.3) * (1 - seg(bt, 7.0, 7.6));
  // deep radial glow
  const rg = ctx.createRadialGradient(960, 560, 0, 960, 560, 900);
  rg.addColorStop(0, hexA(COL.deep, a)); rg.addColorStop(1, hexA(COL.bg, 0));
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  floorGrid(bt, a, 640);
}
function scene2Front(bt) {
  if (bt < 4 || bt >= 7.6) return;
  const out = 1 - seg(bt, 6.9, 7.3);
  // subtitle
  const p = E.outExpo(seg(bt, 4.4, 5.0));
  const f1 = F('NKR', 40, 700), s1 = '생산 현장의 정보를 실시간으로  ', s2 = '수집 · 집계 · 공유';
  const w1 = tw(s1, f1, 2), w2 = tw(s2, f1, 2), x0 = 960 - (w1 + w2) / 2;
  ctx.save(); ctx.globalAlpha = out;
  ctx.beginPath(); ctx.rect(0, 860, W, 70); ctx.clip();
  text(s1, x0, 912 + (1 - p) * 60, { f: 'NKR', w: 700, size: 40, ls: 2, color: COL.white });
  text(s2, x0 + w1, 912 + (1 - E.outExpo(seg(bt, 4.6, 5.2))) * 60, { f: 'NKR', w: 700, size: 40, ls: 2, color: COL.cyan });
  ctx.restore();
  // callouts
  for (const co of CALLOUTS) {
    const q = seg(bt, co.t, co.t + .45);
    if (q <= 0) continue;
    const ax = P.dx[co.a], ay = P.dy[co.a];
    const bw = 300, bh = 64, bx = co.lx, by = co.ly;
    const ex = bx + (bx < ax ? bw : 0), ey = by + bh / 2;
    const lp = E.outCubic(seg(q, 0, .5));
    ctx.save(); ctx.globalAlpha = out;
    ctx.strokeStyle = COL.cyan; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(lerp(ax, ex, lp), lerp(ay, ey, lp)); ctx.stroke();
    // anchor ring
    const rp = frac(bt * 2 - co.t * 2);
    ctx.beginPath(); ctx.arc(ax, ay, 8 + rp * 22, 0, 7); ctx.globalAlpha = out * (1 - rp); ctx.stroke();
    ctx.globalAlpha = out;
    ctx.fillStyle = COL.cyan; ctx.fillRect(ax - 6, ay - 6, 12, 12);
    const bp = E.outExpo(seg(q, .35, 1));
    if (bp > 0) {
      const cw = bw * bp;
      const x = bx < ax ? bx + bw - cw : bx;
      ctx.fillStyle = 'rgba(4,9,20,0.82)'; ctx.fillRect(x, by, cw, bh);
      ctx.strokeRect(x, by, cw, bh);
      ctx.beginPath(); ctx.rect(x, by, cw, bh); ctx.clip();
      text(co.k, bx + 18, by + 41, { f: 'JBM, NKR', w: 700, size: 22, color: COL.mute });
      text(co.v(bt), bx + bw - 18, by + 42, { f: 'JBM', w: 800, size: 26, color: COL.white, align: 'right' });
    }
    ctx.restore();
  }
}

// ============================================================= SCENE 3
// N-MES reveal on a blue block, then a zoom through the hyphen gap
function scene3(bt) {
  if (bt < 7.95 || bt >= 12.1) return;
  const Wd = WORD3, cx = 960, cy = 540;
  const glyphTop = cy - (Wd.asc + Wd.desc) / 2, base = glyphTop + Wd.asc;
  const dx0 = cx - Wd.w / 2, dy0 = cy - Wd.h / 2;
  const px = dx0 + Wd.offs[1] + Wd.ws[1] / 2, py = base - Wd.asc * .16;
  const zp = seg(bt, 11.2, 12.02);
  const zs = Math.exp(E.inCubic(zp) * Math.log(70));
  const k = kickEnv(bt);
  ctx.save();
  // radial glow bg
  const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1000);
  rg.addColorStop(0, '#0E2E63'); rg.addColorStop(1, COL.bg);
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  // background tick grid
  ctx.globalAlpha = .25; ctx.fillStyle = COL.blue;
  for (let y = 60; y < H; y += 60) for (let x = 60; x < W; x += 60) ctx.fillRect(x - 1, y - 1, 2, 2);
  ctx.globalAlpha = 1;
  ctx.translate(px, py); ctx.scale(zs, zs); ctx.rotate(E.inCubic(zp) * .1); ctx.translate(-px, -py);
  const pulse = 1 + k * .015;
  ctx.translate(cx, cy); ctx.scale(pulse, pulse); ctx.translate(-cx, -cy);
  // shock ring from the bang
  const sr = seg(bt, 8, 9.2);
  if (sr > 0 && sr < 1) {
    ctx.strokeStyle = hexA(COL.cyan, 1 - sr); ctx.lineWidth = 6 * (1 - sr) + 1;
    ctx.beginPath(); ctx.arc(cx, cy, E.outExpo(sr) * 1100, 0, 7); ctx.stroke();
    ctx.strokeStyle = hexA(COL.white, (1 - sr) * .6); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, E.outExpo(seg(bt, 8.08, 9.2)) * 820, 0, 7); ctx.stroke();
  }
  // blue slanted block
  const bw = (Wd.w + 120) * E.outExpo(seg(bt, 8.02, 8.55)), bh = Wd.asc + Wd.desc + 150;
  ctx.save(); ctx.translate(cx, cy); ctx.transform(1, 0, -.18, 1, 0, 0);
  ctx.fillStyle = COL.blue; ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
  ctx.restore();
  // sliced word
  const N = 7, sh = Wd.h / N;
  for (let i = 0; i < N; i++) {
    const t0 = 8.1 + i * .035, p = E.outExpo(seg(bt, t0, t0 + .55));
    if (p <= 0) continue;
    const off = (i % 2 ? 1 : -1) * W * (1 - p);
    ctx.drawImage(Wd.c, 0, i * sh, Wd.w, sh + 1, dx0 + off, dy0 + i * sh, Wd.w, sh + 1);
  }
  // echo outlines
  for (const eb of [10, 10.5, 11]) {
    const e = seg(bt, eb, eb + .9);
    if (e <= 0 || e >= 1) continue;
    const s = 1 + E.outCubic(e) * .45;
    ctx.save(); ctx.globalAlpha = (1 - e) * .7;
    ctx.translate(cx, cy); ctx.scale(s, s); ctx.translate(-cx, -cy);
    ctx.font = F('ARC', 400); ctx.textAlign = 'center'; ctx.strokeStyle = COL.cyan; ctx.lineWidth = 3 / s;
    ctx.strokeText('N-MES', cx, base);
    ctx.restore();
  }
  // labels
  const lp = E.outExpo(seg(bt, 8.55, 9.1));
  text('제조실행시스템', cx, glyphTop - 110 + (1 - lp) * 40, { f: 'NKR', w: 900, size: 56, ls: 22, color: COL.white, align: 'center', alpha: lp });
  const s3 = 'MANUFACTURING EXECUTION SYSTEM', tp = seg(bt, 9.0, 10.0);
  const shown = s3.slice(0, Math.ceil(s3.length * tp));
  if (tp > 0) {
    const fnt = F('JBM', 30, 800), full = tw(s3, fnt, 14);
    text(shown, cx - full / 2, base + Wd.desc + 150, { f: 'JBM', w: 800, size: 30, ls: 14, color: COL.cyan });
    if (tp < 1 || frac(bt * 2) < .5) { ctx.fillStyle = COL.cyan; ctx.fillRect(cx - full / 2 + tw(shown, fnt, 14) + 18, base + Wd.desc + 124, 16, 30); }
  }
  ctx.restore();
  // vertical side labels (outside the zoom so they don't fly in the camera move)
  const sp = E.outExpo(seg(bt, 9.3, 9.8)) * (1 - seg(bt, 11.2, 11.5));
  if (sp > 0) {
    ctx.save(); ctx.translate(112, cy); ctx.rotate(-Math.PI / 2);
    text('SMART FACTORY SOLUTION', 0, 0, { f: 'JBM', w: 800, size: 18, ls: 8, color: COL.mute, align: 'center', alpha: sp });
    ctx.restore();
    ctx.save(); ctx.translate(W - 112, cy); ctx.rotate(Math.PI / 2);
    text('NSOFT · N-MES', 0, 0, { f: 'JBM', w: 800, size: 18, ls: 8, color: COL.mute, align: 'center', alpha: sp });
    ctx.restore();
  }
}

// ============================================================= SCENE 4
// 4M panels slam in one per beat on a blue field, then leave as blinds
function iconPath(kind, t) {
  ctx.beginPath();
  if (kind === 0) { // material: isometric box
    const r = 92, c = .866;
    ctx.moveTo(0, -r); ctx.lineTo(r * c, -r / 2); ctx.lineTo(r * c, r / 2); ctx.lineTo(0, r); ctx.lineTo(-r * c, r / 2); ctx.lineTo(-r * c, -r / 2); ctx.closePath();
    ctx.moveTo(-r * c, -r / 2); ctx.lineTo(0, 0); ctx.lineTo(r * c, -r / 2); ctx.moveTo(0, 0); ctx.lineTo(0, r);
    ctx.moveTo(-r * c / 2, -r * .75); ctx.lineTo(r * c / 2, -r / 4);
  } else if (kind === 1) { // machine: gear
    const n = 10, r1 = 90, r2 = 70, rot = t * .9;
    for (let i = 0; i <= n * 4; i++) {
      const a = rot + i / (n * 4) * Math.PI * 2, rr = (i % 4 === 0 || i % 4 === 1) ? r1 : r2;
      i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath(); ctx.moveTo(30, 0); ctx.arc(0, 0, 30, 0, Math.PI * 2);
  } else if (kind === 2) { // method: checklist
    ctx.rect(-70, -90, 140, 180); ctx.moveTo(-26, -90); ctx.lineTo(-26, -104); ctx.lineTo(26, -104); ctx.lineTo(26, -90);
    for (let j = 0; j < 3; j++) {
      const y = -45 + j * 48;
      ctx.moveTo(-46, y); ctx.lineTo(-36, y + 10); ctx.lineTo(-18, y - 10);
      ctx.moveTo(0, y); ctx.lineTo(46, y);
    }
  } else { // man: worker with helmet
    ctx.moveTo(34, -30); ctx.arc(0, -30, 34, 0, Math.PI * 2);
    ctx.moveTo(-44, -44); ctx.arc(0, -44, 44, Math.PI, Math.PI * 2); ctx.moveTo(-58, -44); ctx.lineTo(58, -44);
    ctx.moveTo(-84, 92); ctx.bezierCurveTo(-84, 30, -40, 18, 0, 18); ctx.bezierCurveTo(40, 18, 84, 30, 84, 92);
  }
}
const M4 = [
  { k: '자재', e: 'MATERIAL' }, { k: '설비', e: 'MACHINE' }, { k: '작업방법', e: 'METHOD' }, { k: '작업자', e: 'MAN' },
];
function scene4(bt) {
  if (bt < 12 || bt >= 16.4) return;
  const colW = W / 4, blind = seg(bt, 15.62, 16.3);
  const header = seg(bt, 12.0, 12.4) * (1 - seg(bt, 15.4, 15.7));
  for (let i = 0; i < 4; i++) {
    const bp = E.inExpo(blind);
    const oy = (i % 2 ? 1 : -1) * H * 1.05 * clamp((bp * 1.25) - i * .08);
    ctx.save();
    ctx.beginPath(); ctx.rect(i * colW - .5, 0, colW + 1, H); ctx.clip();
    ctx.translate(0, oy);
    ctx.fillStyle = COL.blue; ctx.fillRect(i * colW, -10, colW, H + 20);
    // moving diagonal stripes
    ctx.save(); ctx.globalAlpha = .08; ctx.strokeStyle = COL.white; ctx.lineWidth = 18;
    ctx.beginPath(); const so = frac(bt * .5) * 80;
    for (let x = -H; x < W; x += 80) { ctx.moveTo(x + so, H); ctx.lineTo(x + so + H, 0); }
    ctx.stroke(); ctx.restore();
    // panel
    const b = 12 + i, dp = E.outExpo(seg(bt, b, b + .4));
    if (bt >= b) {
      const dir = i % 2 ? 1 : -1;
      const px = i * colW + 14, pw = colW - 28, py = 196, ph = 800;
      ctx.save();
      ctx.translate(0, dir * (1 - dp) * H);
      ctx.fillStyle = COL.ink; ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = hexA(COL.cyan, .35); ctx.lineWidth = 2; ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
      // top accent bar
      ctx.fillStyle = COL.cyan; ctx.fillRect(px, py, pw * E.outExpo(seg(bt, b + .1, b + .6)), 6);
      text('0' + (i + 1), px + 34, py + 80, { f: 'ARC', size: 52, color: COL.blue });
      text('M', px + pw - 34, py + 80, { f: 'ARC', size: 52, color: hexA(COL.white, .12), align: 'right' });
      // icon
      const ip = E.outCubic(seg(bt, b + .1, b + .9));
      ctx.save(); ctx.translate(px + pw / 2, py + 300);
      ctx.strokeStyle = COL.cyan; ctx.lineWidth = 7; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.setLineDash([1400]); ctx.lineDashOffset = 1400 * (1 - ip);
      ctx.shadowColor = COL.cyan; ctx.shadowBlur = 18;
      iconPath(i, bt); ctx.stroke();
      ctx.restore();
      const tp = E.outExpo(seg(bt, b + .15, b + .6));
      ctx.save(); ctx.beginPath(); ctx.rect(px, py + 470, pw, 200); ctx.clip();
      text(M4[i].k, px + 34, py + 600 + (1 - tp) * 140, { size: i === 2 ? 96 : 118, color: COL.white });
      ctx.restore();
      text(M4[i].e, px + 36, py + 670, { f: 'SG', w: 700, size: 30, ls: 8, color: COL.blueHi, alpha: seg(bt, b + .3, b + .6) });
      // live bar
      const lb = seg(bt, b + .4, b + 1.0);
      ctx.fillStyle = hexA(COL.white, .12); ctx.fillRect(px + 36, py + 728, pw - 72, 8);
      ctx.fillStyle = COL.cyan; ctx.fillRect(px + 36, py + 728, (pw - 72) * E.outExpo(lb) * (.7 + .3 * Math.sin(bt * 3 + i) ** 2), 8);
      text('● ONLINE', px + pw - 36, py + 770, { f: 'JBM', w: 800, size: 16, ls: 3, color: COL.cyan, align: 'right', alpha: lb * (frac(bt * 2) < .7 ? 1 : .35) });
      // landing flash
      const fl = 1 - seg(bt, b, b + .3);
      if (fl > 0) { ctx.fillStyle = hexA(COL.white, fl * .5); ctx.fillRect(px, py, pw, ph); }
      ctx.restore();
    }
    ctx.restore();
  }
  // header
  if (header > 0) {
    const hp = E.outExpo(seg(bt, 12.0, 12.5));
    ctx.save(); ctx.globalAlpha = header;
    text('4M', 60 + (1 - hp) * -200, 150, { f: 'ARC', size: 76, color: COL.ink });
    text('현장의 모든 요소를 실시간으로 연결', 200 + (1 - hp) * -200, 142, { f: 'NKR', w: 900, size: 42, ls: 1, color: COL.white });
    text('MATERIAL · MACHINE · METHOD · MAN', W - 60, 140, { f: 'JBM', w: 800, size: 20, ls: 4, color: COL.ink, align: 'right', alpha: hp });
    ctx.restore();
  }
}

// ============================================================= SCENE 5
// real-time monitoring dashboard
const LINE_DATA = (() => { const r = rng(55), a = []; for (let i = 0; i < 28; i++) a.push(clamp(.18 + .55 * i / 27 + .16 * Math.sin(i * .95) + .07 * Math.sin(i * 2.6 + 1) + (r() - .5) * .06, .06, .96)); return a; })();
function card(x, y, w, h, p, title) {
  const s = lerp(.9, 1, E.outBack(p)), a = clamp(p * 1.6);
  ctx.translate(x + w / 2, y + h / 2); ctx.scale(s, s); ctx.translate(-x - w / 2, -y - h / 2);
  ctx.globalAlpha = a;
  ctx.fillStyle = COL.card; rrect(x, y, w, h, 16); ctx.fill();
  ctx.strokeStyle = hexA(COL.cyan, .22); ctx.lineWidth = 1.5; ctx.stroke();
  // top light sweep
  const sw = seg(p, .2, 1);
  if (sw > 0 && sw < 1) {
    const g = ctx.createLinearGradient(x + w * sw - 140, 0, x + w * sw + 140, 0);
    g.addColorStop(0, hexA(COL.cyan, 0)); g.addColorStop(.5, hexA(COL.cyan, 1)); g.addColorStop(1, hexA(COL.cyan, 0));
    ctx.fillStyle = g; ctx.fillRect(x, y, w, 3);
  }
  text(title, x + 28, y + 50, { f: 'NKR', w: 700, size: 24, color: COL.mute });
}
function scene5(bt, ox = 0) {
  if (bt < 15.6 || bt >= 20.2) return;
  const k = kickEnv(bt);
  ctx.save();
  ctx.translate(ox, 0);
  ctx.fillStyle = COL.bg; ctx.fillRect(-10, 0, W + 20, H);
  ctx.globalAlpha = .18; ctx.fillStyle = COL.blue;
  for (let y = 40; y < H; y += 40) for (let x = 40; x < W; x += 40) ctx.fillRect(x - 1, y - 1, 2, 2);
  ctx.globalAlpha = 1;
  const drift = (bt - 16) * -6, zb = 1 + k * .006;
  ctx.translate(960, 540); ctx.scale(zb, zb); ctx.translate(-960 + drift, -540);
  // title block
  for (const [s, y, b] of [['실시간', 420, 15.8], ['모니터링', 580, 15.92]]) {
    const p = E.outExpo(seg(bt, b, b + .45));
    ctx.save(); ctx.beginPath(); ctx.rect(100, y - 150, 700, 175); ctx.clip();
    text(s, 120, y + (1 - p) * 170, { size: 150, color: COL.white });
    ctx.restore();
  }
  ctx.fillStyle = COL.blue; ctx.fillRect(122, 632, 560 * E.outExpo(seg(bt, 16.0, 16.5)), 12);
  text('REAL-TIME MONITORING', 122, 700, { f: 'JBM', w: 800, size: 24, ls: 8, color: COL.cyan, alpha: seg(bt, 16.4, 16.7) });
  text('공정 · 자재 · 품질 · 설비 현황을 한눈에', 122, 752, { f: 'NKR', w: 400, size: 28, color: COL.mute, alpha: seg(bt, 16.6, 16.9) });
  // card A: line chart
  let p = seg(bt, 16.25, 16.75);
  if (p > 0) {
    ctx.save(); card(800, 140, 1010, 390, p, '시간대별 생산 실적');
    const lx = 830, ly = 200, lw = 950, lh = 290;
    ctx.strokeStyle = hexA(COL.white, .07); ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) { ctx.beginPath(); ctx.moveTo(lx, ly + 20 + g * (lh - 20) / 4); ctx.lineTo(lx + lw, ly + 20 + g * (lh - 20) / 4); ctx.stroke(); }
    const dp = E.inOutCubic(seg(bt, 16.5, 18.6)), n = LINE_DATA.length, last = dp * (n - 1);
    const pt = i => [lx + i / (n - 1) * lw, ly + lh - LINE_DATA[i] * (lh - 30)];
    const ptf = f => { const i = Math.floor(f), t = f - i; if (i >= n - 1) return pt(n - 1); const a = pt(i), b = pt(i + 1); return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]; };
    if (last > 0) {
      ctx.beginPath(); ctx.moveTo(...pt(0));
      for (let i = 1; i <= Math.floor(last); i++) ctx.lineTo(...pt(i));
      const hd = ptf(last); ctx.lineTo(...hd);
      const ag = ctx.createLinearGradient(0, ly, 0, ly + lh);
      ag.addColorStop(0, hexA(COL.blue, .45)); ag.addColorStop(1, hexA(COL.blue, 0));
      ctx.save(); ctx.lineTo(hd[0], ly + lh); ctx.lineTo(lx, ly + lh); ctx.closePath(); ctx.fillStyle = ag; ctx.fill(); ctx.restore();
      ctx.beginPath(); ctx.moveTo(...pt(0)); for (let i = 1; i <= Math.floor(last); i++) ctx.lineTo(...pt(i)); ctx.lineTo(...hd);
      ctx.strokeStyle = COL.cyan; ctx.lineWidth = 4; ctx.shadowColor = COL.cyan; ctx.shadowBlur = 16; ctx.stroke();
      ctx.shadowBlur = 0; ctx.fillStyle = COL.white; ctx.beginPath(); ctx.arc(hd[0], hd[1], 8 + k * 6, 0, 7); ctx.fill();
      ctx.strokeStyle = hexA(COL.cyan, .5); ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
      ctx.beginPath(); ctx.moveTo(hd[0], hd[1]); ctx.lineTo(hd[0], ly + lh); ctx.stroke(); ctx.setLineDash([]);
    }
    text('LIVE', 1782, 190, { f: 'JBM', w: 800, size: 20, ls: 4, color: COL.hot, align: 'right' });
    ctx.fillStyle = COL.hot; ctx.globalAlpha *= frac(bt) < .5 ? 1 : .25; ctx.beginPath(); ctx.arc(1712, 183, 7, 0, 7); ctx.fill();
    ctx.restore();
  }
  // card B: ring gauge
  p = seg(bt, 16.5, 17.0);
  if (p > 0) {
    ctx.save(); card(800, 555, 320, 380, p, '설비 가동률');
    const gp = E.outCubic(seg(bt, 16.7, 18.2)), v = .964 * gp, gx = 960, gy = 760;
    ctx.lineCap = 'round'; ctx.lineWidth = 20;
    ctx.strokeStyle = hexA(COL.white, .08); ctx.beginPath(); ctx.arc(gx, gy, 110, 0, 7); ctx.stroke();
    ctx.strokeStyle = COL.blue; ctx.shadowColor = COL.blue; ctx.shadowBlur = 20;
    ctx.beginPath(); ctx.arc(gx, gy, 110, -Math.PI / 2, -Math.PI / 2 + v * Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    text((v * 100).toFixed(1), gx - 8, gy + 20, { f: 'ARC', size: 58, color: COL.white, align: 'center' });
    text('%', gx + 76, gy + 20, { f: 'ARC', size: 28, color: COL.cyan });
    ctx.restore();
  }
  // card C: counter
  p = seg(bt, 16.75, 17.25);
  if (p > 0) {
    ctx.save(); card(1145, 555, 320, 380, p, '금일 생산량');
    const cp = E.outQuart(seg(bt, 16.9, 18.6)), val = Math.floor(12480 * cp + (bt > 18.6 ? (bt - 18.6) * 9 : 0));
    text(val.toLocaleString('en-US'), 1175, 720, { f: 'JBM', w: 800, size: 62, color: COL.white });
    text('EA', 1175, 770, { f: 'JBM', w: 800, size: 24, ls: 4, color: COL.cyan });
    for (let i = 0; i < 12; i++) {
      const h = (20 + 70 * Math.abs(Math.sin(i * 1.7 + 2))) * E.outExpo(seg(bt, 17 + i * .05, 17.5 + i * .05));
      ctx.fillStyle = i === 11 ? COL.cyan : hexA(COL.blue, .7);
      ctx.fillRect(1175 + i * 22, 900 - h, 14, h);
    }
    ctx.restore();
  }
  // card D: equipment status
  p = seg(bt, 17.0, 17.5);
  if (p > 0) {
    ctx.save(); card(1490, 555, 320, 380, p, '설비 상태');
    for (let i = 0; i < 6; i++) {
      const rp = seg(bt, 17.15 + i * .08, 17.4 + i * .08); if (rp <= 0) continue;
      const y = 625 + i * 50, stop = i === 3;
      ctx.globalAlpha = rp;
      text(`LINE-0${i + 1}`, 1518, y + 20, { f: 'JBM', w: 500, size: 21, color: COL.white });
      const on = !stop || frac(bt * 4) < .5;
      ctx.fillStyle = stop ? (on ? COL.hot : hexA(COL.hot, .25)) : COL.cyan;
      ctx.beginPath(); ctx.arc(1700, y + 13, 8, 0, 7); ctx.fill();
      text(stop ? 'STOP' : 'RUN', 1782, y + 20, { f: 'JBM', w: 800, size: 20, color: stop ? COL.hot : COL.cyan, align: 'right' });
    }
    ctx.restore();
  }
  ctx.restore();
}

// ============================================================= SCENE 6
// barcode scan -> LOT trace chain (forward trace + backtrace)
const CHAIN = ['원자재', '가공', '조립', '검사', '완제품'];
function barcode(x, y, w, h, scan) {
  const u = w / BARS.units;
  for (const [s, bw] of BARS) {
    const bx = x + s * u, scanned = bx + bw * u / 2 < scan;
    ctx.fillStyle = scanned ? COL.cyan : COL.white;
    ctx.fillRect(bx, y, bw * u - .5, h);
  }
}
function scene6(bt, ox = 0) {
  if (bt < 19.6 || bt >= 24.1) return;
  ctx.save();
  ctx.translate(ox, 0);
  ctx.fillStyle = '#050D22'; ctx.fillRect(-10, 0, W + 20, H);
  ctx.globalAlpha = .16; ctx.strokeStyle = COL.blue; ctx.lineWidth = 1;
  ctx.beginPath(); for (let x = 0; x <= W; x += 120) { ctx.moveTo(x, 0); ctx.lineTo(x, H); } for (let y = 0; y <= H; y += 120) { ctx.moveTo(0, y); ctx.lineTo(W, y); } ctx.stroke();
  ctx.globalAlpha = 1;
  // barcode group, shrinks into a tag above the chain from beat 22
  const zp = E.inOutCubic(seg(bt, 21.9, 22.5));
  const gs = lerp(1, .34, zp), gx = 960, gy = lerp(410, 215, zp);
  const bw = 1100, bh = 330;
  const scan = lerp(960 - bw / 2 - 40, 960 + bw / 2 + 40, E.inOutCubic(seg(bt, 20.25, 21.0)));
  ctx.save();
  ctx.translate(gx, gy); ctx.scale(gs, gs); ctx.translate(-960, -410);
  // brackets
  const brp = E.outExpo(seg(bt, 20.0, 20.4));
  ctx.strokeStyle = COL.cyan; ctx.lineWidth = 5 / Math.max(gs, .5);
  const bx0 = 960 - bw / 2 - 50, by0 = 410 - bh / 2 - 50, bx1 = 960 + bw / 2 + 50, by1 = 410 + bh / 2 + 50, L = 60 * brp;
  const ins = (1 - brp) * 80;
  ctx.beginPath();
  ctx.moveTo(bx0 - ins, by0 - ins + L); ctx.lineTo(bx0 - ins, by0 - ins); ctx.lineTo(bx0 - ins + L, by0 - ins);
  ctx.moveTo(bx1 + ins - L, by0 - ins); ctx.lineTo(bx1 + ins, by0 - ins); ctx.lineTo(bx1 + ins, by0 - ins + L);
  ctx.moveTo(bx0 - ins, by1 + ins - L); ctx.lineTo(bx0 - ins, by1 + ins); ctx.lineTo(bx0 - ins + L, by1 + ins);
  ctx.moveTo(bx1 + ins - L, by1 + ins); ctx.lineTo(bx1 + ins, by1 + ins); ctx.lineTo(bx1 + ins, by1 + ins - L);
  ctx.stroke();
  barcode(960 - bw / 2, 410 - bh / 2, bw, bh, scan);
  // laser
  if (bt >= 20.2 && bt < 21.1) {
    const la = 1 - seg(bt, 21.0, 21.1);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(scan - 90, 0, scan + 90, 0);
    g.addColorStop(0, hexA(COL.hot, 0)); g.addColorStop(.5, hexA(COL.hot, .55 * la)); g.addColorStop(1, hexA(COL.hot, 0));
    ctx.fillStyle = g; ctx.fillRect(scan - 90, 410 - bh / 2 - 80, 180, bh + 160);
    ctx.fillStyle = hexA('#FFE3D8', la); ctx.fillRect(scan - 2.5, 410 - bh / 2 - 80, 5, bh + 160);
    ctx.restore();
  }
  // lot number
  const lot = 'LOT-2609-0417-A7', lp = seg(bt, 20.3, 21.0);
  if (lp > 0) {
    const f = F('JBM', 44, 800), full = tw(lot, f, 10);
    text(lot.slice(0, Math.ceil(lot.length * lp)), 960 - full / 2, 410 + bh / 2 + 100, { f: 'JBM', w: 800, size: 44, ls: 10, color: COL.white });
  }
  // scan OK badge
  const okp = E.outBack(seg(bt, 21.0, 21.3));
  if (okp > 0) {
    ctx.save(); ctx.translate(bx1 - 20, by0 + 10); ctx.scale(okp, okp);
    ctx.fillStyle = COL.cyan; rrect(-210, -30, 220, 60, 30); ctx.fill();
    ctx.strokeStyle = COL.ink; ctx.lineWidth = 6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-180, 0); ctx.lineTo(-166, 13); ctx.lineTo(-142, -12); ctx.stroke();
    text('SCAN OK', -120, 10, { f: 'JBM', w: 800, size: 24, ls: 2, color: COL.ink });
    ctx.restore();
  }
  ctx.restore();
  // chain
  if (bt >= 22.0) {
    const xs = CHAIN.map((_, i) => 360 + i * 300), cy = 560, ns = 150;
    const fw = E.inOutCubic(seg(bt, 22.55, 23.15)), bk = E.inOutCubic(seg(bt, 23.15, 23.65));
    const fx = lerp(xs[0], xs[4], fw), bx = lerp(xs[4], xs[0], bk);
    // links
    const lkp = E.outCubic(seg(bt, 22.15, 22.6));
    ctx.strokeStyle = hexA(COL.blue, .6); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(xs[0], cy); ctx.lineTo(lerp(xs[0], xs[4], lkp), cy); ctx.stroke();
    if (fw > 0) { ctx.strokeStyle = COL.cyan; ctx.lineWidth = 6; ctx.shadowColor = COL.cyan; ctx.shadowBlur = 20; ctx.beginPath(); ctx.moveTo(xs[0], cy); ctx.lineTo(fx, cy); ctx.stroke(); ctx.shadowBlur = 0; }
    if (bk > 0) { ctx.strokeStyle = COL.hot; ctx.lineWidth = 6; ctx.shadowColor = COL.hot; ctx.shadowBlur = 20; ctx.beginPath(); ctx.moveTo(xs[4], cy + 14); ctx.lineTo(bx, cy + 14); ctx.stroke(); ctx.shadowBlur = 0; }
    CHAIN.forEach((s, i) => {
      const np = E.outBack(seg(bt, 22.05 + i * .07, 22.4 + i * .07));
      if (np <= 0) return;
      const litF = fw > 0 && fx >= xs[i] - 2, litB = bk > 0 && bx <= xs[i] + 2;
      ctx.save(); ctx.translate(xs[i], cy); ctx.scale(np, np);
      ctx.fillStyle = litB ? '#2A0F0C' : litF ? '#0B2E4F' : COL.card;
      rrect(-ns / 2, -ns / 2, ns, ns, 22); ctx.fill();
      ctx.lineWidth = litF || litB ? 4 : 2;
      ctx.strokeStyle = litB ? COL.hot : litF ? COL.cyan : hexA(COL.blue, .6);
      if (litF || litB) { ctx.shadowColor = ctx.strokeStyle; ctx.shadowBlur = 24; }
      ctx.stroke(); ctx.shadowBlur = 0;
      text('0' + (i + 1), -ns / 2 + 18, -ns / 2 + 34, { f: 'JBM', w: 800, size: 18, color: litB ? COL.hot : COL.cyan });
      text(s, 0, 22, { f: 'NKR', w: 900, size: s.length > 2 ? 34 : 40, color: COL.white, align: 'center' });
      ctx.restore();
    });
    // pulses
    const dot = (x, y, c) => { ctx.save(); ctx.globalCompositeOperation = 'lighter'; const g = ctx.createRadialGradient(x, y, 0, x, y, 60); g.addColorStop(0, hexA(COL.white, 1)); g.addColorStop(.2, hexA(c, .9)); g.addColorStop(1, hexA(c, 0)); ctx.fillStyle = g; ctx.fillRect(x - 60, y - 60, 120, 120); ctx.restore(); };
    if (fw > 0 && fw < 1) dot(fx, cy, COL.cyan);
    if (bk > 0 && bk < 1) dot(bx, cy + 14, COL.hot);
    text('TRACE  →', xs[0] - ns / 2, cy - 120, { f: 'JBM', w: 800, size: 22, ls: 6, color: COL.cyan, alpha: seg(bt, 22.55, 22.8) });
    text('←  BACKTRACE', xs[4] + ns / 2, cy + 150, { f: 'JBM', w: 800, size: 22, ls: 6, color: COL.hot, align: 'right', alpha: seg(bt, 23.15, 23.4) });
  }
  // titles (swap at beat 22)
  const sw = E.inOutCubic(seg(bt, 21.85, 22.3));
  ctx.save(); ctx.beginPath(); ctx.rect(0, 740, W, 250); ctx.clip();
  const t1 = E.outExpo(seg(bt, 20.1, 20.6));
  text('바코드 기반 관리', 960, 880 + (1 - t1) * 120 - sw * 250, { size: 100, color: COL.white, align: 'center' });
  text('입력 오류 · 누락 방지, 정확한 데이터 수집', 960, 950 + (1 - t1) * 120 - sw * 250, { f: 'NKR', w: 700, size: 30, color: COL.mute, align: 'center', alpha: seg(bt, 20.3, 20.7) });
  text('LOT 추적 · 역추적', 960, 880 + (1 - sw) * 250, { size: 100, color: COL.white, align: 'center' });
  text('원자재 투입부터 완제품까지, 전 이력을 한 번에', 960, 950 + (1 - sw) * 250, { f: 'NKR', w: 700, size: 30, color: COL.mute, align: 'center' });
  ctx.restore();
  ctx.restore();
}

// ============================================================= SCENE 7
// 입고 → 생산 → 품질 → 납품 : one word per beat, conveyor wipes
const FLOW = [
  { k: '입고', e: 'INBOUND', bg: COL.blue, fg: COL.white, sub: COL.ink },
  { k: '생산', e: 'PRODUCTION', bg: COL.white, fg: COL.navy, sub: COL.blue },
  { k: '품질', e: 'QUALITY', bg: COL.navy, fg: COL.cyan, sub: COL.white },
  { k: '납품', e: 'DELIVERY', bg: COL.ink, fg: COL.white, sub: COL.blue },
];
function flowLayer(i, bt) {
  const d = FLOW[i], b = 24 + i;
  let bg = d.bg, fg = d.fg, sub = d.sub, sc = 1;
  if (i === 3 && bt >= 27.5) {
    const st = Math.min(3, Math.floor((bt - 27.5) * 8));
    sc = [1.1, 1.22, 1.36, 1.52][st];
    if (st % 2 === 0) { bg = COL.white; fg = COL.ink; sub = COL.blue; }
  }
  ctx.fillStyle = bg; ctx.fillRect(-20, -20, W + 40, H + 40);
  const p = E.outExpo(seg(bt, b, b + .4));
  const x = 960 + (1 - p) * 520;
  ctx.save();
  ctx.translate(x, 590); ctx.transform(1, 0, -.35 * (1 - p), 1, 0, 0); ctx.scale(sc, sc);
  text(d.k, 0, 145, { size: 400, color: fg, align: 'center' });
  ctx.restore();
  text(d.e, 960 + (1 - p) * 300, 330, { f: 'SG', w: 700, size: 36, ls: 26, color: sub, align: 'center' });
  text('입고부터 납품까지, 하나의 흐름으로', 960, 190, { f: 'NKR', w: 700, size: 32, ls: 2, color: sub, align: 'center' });
  // progress rail
  const rx0 = 560, rx1 = 1360, ry = 900;
  ctx.fillStyle = hexA(fg, .22); ctx.fillRect(rx0, ry - 2, rx1 - rx0, 4);
  const fp = (i + E.outExpo(seg(bt, b, b + .4))) / 3;
  ctx.fillStyle = fg; ctx.fillRect(rx0, ry - 3, (rx1 - rx0) * clamp(i === 0 ? 0 : (i - 1 + E.outExpo(seg(bt, b, b + .4))) / 3), 6);
  for (let j = 0; j < 4; j++) {
    ctx.beginPath(); ctx.arc(rx0 + j * (rx1 - rx0) / 3, ry, j <= i ? 11 : 8, 0, 7);
    ctx.fillStyle = j <= i ? fg : bg; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = fg; ctx.stroke();
    text(FLOW[j].k, rx0 + j * (rx1 - rx0) / 3, ry + 50, { f: 'NKR', w: 700, size: 22, color: fg, align: 'center', alpha: j <= i ? 1 : .4 });
  }
  void fp;
  text(`0${i + 1} / 04`, 150, 330, { f: 'JBM', w: 800, size: 24, ls: 4, color: sub });
}
function scene7(bt) {
  if (bt < 23.6 || bt >= 28.05) return;
  // slab wipe from scene 6
  if (bt < 24) {
    const e = lerp(-500, W + 700, E.inOutCubic(seg(bt, 23.62, 24.0)));
    ctx.fillStyle = COL.blue;
    ctx.beginPath(); ctx.moveTo(-600, 0); ctx.lineTo(e, 0); ctx.lineTo(e - 450, H); ctx.lineTo(-600, H); ctx.fill();
    ctx.fillStyle = COL.cyan;
    ctx.beginPath(); ctx.moveTo(e, 0); ctx.lineTo(e + 40, 0); ctx.lineTo(e - 410, H); ctx.lineTo(e - 450, H); ctx.fill();
    return;
  }
  const i = clamp(Math.floor(bt - 24), 0, 3);
  if (i === 0) { flowLayer(0, bt); return; }
  const b = 24 + i, wp = E.outExpo(seg(bt, b, b + .32));
  if (wp >= 1) { flowLayer(i, bt); return; }
  flowLayer(i - 1, bt);
  const edge = lerp(W + 400, -500, wp);
  ctx.save();
  ctx.beginPath(); ctx.moveTo(edge + 300, 0); ctx.lineTo(W + 800, 0); ctx.lineTo(W + 800, H); ctx.lineTo(edge, H); ctx.closePath(); ctx.clip();
  flowLayer(i, bt);
  ctx.restore();
  ctx.strokeStyle = COL.cyan; ctx.lineWidth = 10;
  ctx.beginPath(); ctx.moveTo(edge + 300, 0); ctx.lineTo(edge, H); ctx.stroke();
}

// ============================================================= SCENE 8
// end card: impact, N-MES lockup, tagline callback, NSOFT
const BURST = (() => { const r = rng(808), a = []; for (let i = 0; i < 160; i++) a.push([r() * Math.PI * 2, 300 + r() * 900, 2 + r() * 5, r()]); return a; })();
function scene8(bt) {
  if (bt < 28) return;
  const cx = 960, cy = 540, zoom = 1 + (bt - 28) * .008;
  ctx.save();
  const rg = ctx.createRadialGradient(cx, 470, 0, cx, 470, 1100);
  rg.addColorStop(0, '#0D2A5C'); rg.addColorStop(.55, COL.bg); rg.addColorStop(1, COL.bg);
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  ctx.translate(cx, cy); ctx.scale(zoom, zoom); ctx.translate(-cx, -cy);
  // dot field with ripple (callback to the data dots)
  const rp = (bt - 28) * 900;
  for (let y = 30; y < H; y += 36) for (let x = 30; x < W; x += 36) {
    const d = Math.hypot(x - cx, y - 470), k = Math.exp(-(((d - rp) / 120) ** 2));
    const base = .07 + .05 * Math.max(0, 1 - d / 900);
    ctx.fillStyle = k > .3 ? hexA(COL.cyan, .25 + k * .6) : hexA(COL.blue, base * 2.2);
    const s = 3 + k * 5; ctx.fillRect(x - s / 2, y - s / 2, s, s);
  }
  // rings
  for (const [b0, c, w] of [[28, COL.cyan, 8], [28.12, COL.white, 3], [29, COL.blue, 3]]) {
    const q = seg(bt, b0, b0 + 1.4); if (q <= 0 || q >= 1) continue;
    ctx.strokeStyle = hexA(c, 1 - q); ctx.lineWidth = w * (1 - q) + 1;
    ctx.beginPath(); ctx.arc(cx, 470, E.outExpo(q) * 1200, 0, 7); ctx.stroke();
  }
  // burst particles
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  for (const [a, sp, s, r] of BURST) {
    const q = seg(bt, 28, 30.2); if (q >= 1) break;
    const d = E.outExpo(q) * sp;
    ctx.fillStyle = hexA(r > .5 ? COL.cyan : COL.blueHi, 1 - q);
    ctx.fillRect(cx + Math.cos(a) * d - s / 2, 470 + Math.sin(a) * d * .75 - s / 2, s, s);
  }
  ctx.restore();
  // N-MES lockup
  const Wd = WORD8, top = 470 - (Wd.asc + Wd.desc) / 2, base = top + Wd.asc, dx0 = cx - Wd.w / 2, dy0 = 470 - Wd.h / 2;
  const N = 5, sh = Wd.h / N;
  for (let i = 0; i < N; i++) {
    const t0 = 28.02 + i * .03, p = E.outExpo(seg(bt, t0, t0 + .45));
    const off = (i % 2 ? 1 : -1) * 700 * (1 - p);
    ctx.globalAlpha = clamp(p * 3);
    ctx.drawImage(Wd.c, 0, i * sh, Wd.w, sh + 1, dx0 + off, dy0 + i * sh, Wd.w, sh + 1);
  }
  ctx.globalAlpha = 1;
  // specular sweep across the word
  const sw = seg(bt, 30.9, 31.5);
  if (sw > 0 && sw < 1) {
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0); tmpCtx.clearRect(0, 0, Wd.w, Wd.h);
    tmpCtx.globalCompositeOperation = 'source-over'; tmpCtx.drawImage(Wd.c, 0, 0);
    tmpCtx.globalCompositeOperation = 'source-in';
    const sx = lerp(-300, Wd.w + 300, E.inOutCubic(sw));
    const g = tmpCtx.createLinearGradient(sx - 160, 0, sx + 160, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.5, 'rgba(255,255,255,0.95)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    tmpCtx.fillStyle = g; tmpCtx.fillRect(0, 0, Wd.w, Wd.h);
    tmpCtx.globalCompositeOperation = 'source-over';
    ctx.drawImage(tmpCv, 0, 0, Wd.w, Wd.h, dx0, dy0, Wd.w, Wd.h);
  }
  ctx.fillStyle = COL.blue; const ul = 180 * E.outExpo(seg(bt, 28.3, 28.8)); ctx.fillRect(cx - ul, base + 36, ul * 2, 8);
  // tagline, char by char
  const tag = '현장의 모든 순간을, 데이터로.', tf = F('NKR', 60, 900), tagW = tw(tag, tf, 2);
  let x = cx - tagW / 2;
  ctx.save(); ctx.font = tf; ctx.letterSpacing = '2px';
  [...tag].forEach((ch, i) => {
    const p = E.outExpo(seg(bt, 28.45 + i * .035, 28.85 + i * .035));
    const w = ctx.measureText(ch).width;
    if (p > 0) {
      const hl = i >= 11;
      ctx.globalAlpha = p; ctx.fillStyle = hl ? COL.cyan : COL.white;
      ctx.fillText(ch, x, base + 150 + (1 - p) * 40);
    }
    x += w;
  });
  ctx.restore();
  // divider + company
  const dv = E.outExpo(seg(bt, 29.0, 29.5));
  ctx.fillStyle = hexA(COL.white, .35); ctx.fillRect(cx - 200 * dv, base + 200, 400 * dv, 2);
  const cp = E.outExpo(seg(bt, 29.0, 29.6));
  ctx.save(); ctx.beginPath(); ctx.rect(0, base + 215, W, 90); ctx.clip();
  text('NSOFT', cx + 14, base + 290 + (1 - cp) * 90, { f: 'ARC', size: 64, ls: 28, color: COL.white, align: 'center' });
  ctx.restore();
  text('㈜엔소프트  ·  스마트팩토리 솔루션', cx, base + 345, { f: 'NKR', w: 700, size: 26, ls: 3, color: COL.mute, align: 'center', alpha: seg(bt, 29.4, 29.8) });
  text('www.nsoft.co.kr', cx, base + 392, { f: 'JBM', w: 800, size: 24, ls: 5, color: COL.cyan, align: 'center', alpha: seg(bt, 29.6, 30.0) });
  ctx.restore();
}

// ============================================================ FLASHES
const FLASHES = [[2, .35, 2.5], [8, 1, 3.5], [12, .3, 6], [24, .35, 6], [28, 1, 3]];
function flashes(bt) {
  let a = 0;
  for (const [b, s, d] of FLASHES) { const x = bt - b; if (x >= 0 && x < 1) a = Math.max(a, s * Math.exp(-x * d * 2)); }
  // pre-flash build into the final impact
  if (bt < 28) a = Math.max(a, E.inExpo(seg(bt, 27.9, 28)) * .9);
  if (a > .003) { ctx.fillStyle = hexA(COL.white, a); ctx.fillRect(0, 0, W, H); }
}

// =============================================================== FRAME
function renderScene(t) {
  const bt = t / BEAT;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.shadowBlur = 0; ctx.setLineDash([]);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, W, H);
  const sh = shake(bt);
  ctx.save(); ctx.translate(sh.x, sh.y);
  scene2Back(bt);
  scene1(bt);
  particles(bt);
  scene2Front(bt);
  scene3(bt);
  // whip pan 5 -> 6 (scene 5 sits under the scene-4 blinds)
  const whip = E.inOutExpo(seg(bt, 19.55, 20.1));
  scene5(bt, -whip * (W + 200));
  scene4(bt);
  scene6(bt, (1 - whip) * (W + 200));
  if (whip > 0 && whip < 1) {
    const r = rng(Math.floor(bt * 40)), a = Math.sin(whip * Math.PI);
    ctx.fillStyle = hexA(COL.cyan, .5 * a);
    for (let i = 0; i < 26; i++) ctx.fillRect(r() * W, r() * H, 200 + r() * 700, 2 + r() * 3);
  }
  scene7(bt);
  scene8(bt);
  ctx.restore();
  flashes(bt);
  hud(bt);
}

// ----------------------------------------------------------- post FX
function post(t, frame) {
  const bt = t / BEAT;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  // chromatic split on impacts
  const ca = Math.min(22, impactEnv(bt, 6) * 10);
  if (ca > .6) {
    tmpCtx.setTransform(1, 0, 0, 1, 0, 0); tmpCtx.globalCompositeOperation = 'source-over';
    tmpCtx.drawImage(cv, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    for (const [col, dx] of [['#ff0000', -ca], ['#00ff00', 0], ['#0000ff', ca]]) {
      const c2 = channelCanvas(col);
      ctx.drawImage(c2, dx, 0);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  // bloom
  bloomCtx.setTransform(1, 0, 0, 1, 0, 0); bloomCtx.globalCompositeOperation = 'source-over';
  bloomCtx.filter = 'brightness(0.9) contrast(2.2) blur(5px)';
  bloomCtx.clearRect(0, 0, W / 4, H / 4);
  bloomCtx.drawImage(cv, 0, 0, W / 4, H / 4);
  bloomCtx.filter = 'none';
  ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = bt >= 24.3 && bt < 28 ? .22 : .55;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bloomCv, 0, 0, W, H);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  // vignette + grain
  ctx.drawImage(vignette, 0, 0);
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = .09;
  const g = grainTiles[frame % 4], r = rng(frame * 31 + 7), ox = Math.floor(r() * 256), oy = Math.floor(r() * 256);
  for (let y = -oy; y < H; y += 256) for (let x = -ox; x < W; x += 256) ctx.drawImage(g, x, y);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
}
let chCv = null;
function channelCanvas(col) {
  if (!chCv) { chCv = document.createElement('canvas'); chCv.width = W; chCv.height = H; }
  const c = chCv.getContext('2d');
  c.globalCompositeOperation = 'source-over'; c.drawImage(tmpCv, 0, 0);
  c.globalCompositeOperation = 'multiply'; c.fillStyle = col; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
  return chCv;
}

// ------------------------------------------ frame with motion blur
let acc = null;
function renderFrame(frame, sub = 4, shutter = .5) {
  const t0 = frame / FPS;
  if (sub <= 1) { renderScene(t0); post(t0, frame); return; }
  if (!acc) acc = new Float32Array(W * H * 3);
  acc.fill(0);
  for (let s = 0; s < sub; s++) {
    renderScene(Math.min(DUR - 1e-4, t0 + (s / sub) * shutter / FPS));
    const d = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { acc[j] += d[i]; acc[j + 1] += d[i + 1]; acc[j + 2] += d[i + 2]; }
  }
  const out = ctx.createImageData(W, H), o = out.data, inv = 1 / sub;
  for (let i = 0, j = 0; i < o.length; i += 4, j += 3) { o[i] = acc[j] * inv + .5; o[i + 1] = acc[j + 1] * inv + .5; o[i + 2] = acc[j + 2] * inv + .5; o[i + 3] = 255; }
  ctx.putImageData(out, 0, 0);
  post(t0, frame);
}

// ----------------------------------------------------------- boot
const fontsReady = Promise.all([
  'BHS', 'ARC', '400 NKR', '700 NKR', '900 NKR', '500 JBM', '800 JBM', '700 SG',
].map(f => document.fonts.load(`${f.includes(' ') ? f.split(' ')[0] + ' 40px ' + f.split(' ')[1] : '40px ' + f}`, '가A1'))).then(() => document.fonts.ready);

window.MOTION = { W, H, FPS, DUR, BEAT, frames: Math.round(DUR * FPS), renderFrame, renderScene };
window.motionReady = fontsReady.then(() => { init(); return true; });

// live preview: open index.html?play (plays audio.wav alongside if present)
if (/[?&]play/.test(location.search)) {
  window.motionReady.then(() => {
    const au = new Audio('audio.wav');
    let start = null;
    const loop = now => {
      if (start === null) { start = now; au.currentTime = 0; au.play().catch(() => {}); }
      const t = ((now - start) / 1000) % DUR;
      if (t < .03 && now - start > 1000) { start = now; au.currentTime = 0; au.play().catch(() => {}); }
      renderScene(t); post(t, Math.floor(t * FPS));
      requestAnimationFrame(loop);
    };
    document.body.addEventListener('click', () => { start = null; }, { once: false });
    requestAnimationFrame(loop);
  });
} else if (/[?&]t=/.test(location.search)) {
  const t = parseFloat(location.search.match(/t=([\d.]+)/)[1]);
  window.motionReady.then(() => { renderScene(t); post(t, 0); });
}
})();
