/* app.js — CHRONOMANCALA: software-rendered lo-fi 3D Antikythera + mancala.
   Zero dependencies. Canvas 2D with a tiny flat-shaded polygon pipeline,
   PS1-style vertex snapping, and a bronze gear train behind the board. */
"use strict";
import { newGame as newMancala, legalMoves, applyMove, scores, winner, chooseAiMove } from "./game.js";

/* ============================== utils ============================== */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
addEventListener("resize", resize); resize();

/* ============================== 3d math ============================== */
// Rotation: yaw around Y, then pitch around X. Camera looks down -Z... we use
// a lookAt-style basis instead: camPos, camFwd, camRight, camUp.
// dual cameras for the 50/50 split: clock above, board below.
// `cam` is the active camera (set per render pass).
const camClockDef = { pos: [0, 5.2, 7.0], look: [0, 5.2, -7.8], f: 560, sway: 0 };
const camBoardDef = { pos: [0, 9.5, 11.0], look: [0, 0, 0.4], f: 640, sway: 0 };
const cam = { pos: [0, 8, 12.5], look: [0, 0.2, 0], f: 700, sway: 0 };
function setCam(def) {
  cam.pos = def.pos.slice(); cam.look = def.look.slice(); cam.f = def.f; cam.sway = def.sway;
}
// layout: top half = clock, bottom half = board (50/50). Returns rects.
function layout() {
  const split = H * 0.5;
  return {
    clock: { x: 0, y: 0, w: W, h: split },
    board: { x: 0, y: split, w: W, h: H - split },
  };
}
function camBasis() {
  const fwd = norm3(sub3(cam.look, cam.pos));
  const right = norm3(cross3(fwd, [0, 1, 0]));
  const up = cross3(right, fwd);
  return { fwd, right, up };
}
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// viewport (set per render pass for the 50/50 split)
let VX = 0, VY = 0, VW = 0, VH = 0;
// project world -> screen within the current viewport. Returns null behind camera.
function project(p, B) {
  const d = sub3(p, cam.pos);
  const z = dot3(d, B.fwd), x = dot3(d, B.right), y = dot3(d, B.up);
  if (z < 0.5) return null;
  let sx = VX + VW / 2 + (x / z) * cam.f;
  let sy = VY + VH / 2 - (y / z) * cam.f;
  if (!REDUCED) { sx = Math.round(sx) + 0.0; sy = Math.round(sy); } // PS1 snap
  return [sx, sy, z];
}

// rotate point: rz (in-plane spin) first, then yaw around Y, then pitch around X
function rotYX(p, ry, rx, rz) {
  let [x, y, z] = p;
  if (rz) { const c = Math.cos(rz), s = Math.sin(rz); const nx = x * c - y * s, ny = x * s + y * c; x = nx; y = ny; }
  if (ry) { const c = Math.cos(ry), s = Math.sin(ry); const nx = x * c + z * s, nz = -x * s + z * c; x = nx; z = nz; }
  if (rx) { const c = Math.cos(rx), s = Math.sin(rx); const ny = y * c - z * s, nz2 = y * s + z * c; y = ny; z = nz2; }
  return [x, y, z];
}

/* ============================== meshes ============================== */
// Mesh: { v: [[x,y,z]], f: [{ p:[i..], c:[r,g,b], e:emissive } ] }
// Faces are convex polys; triangulated as a fan at draw time.
function boxMesh(w, h, d, c) {
  const x = w / 2, y = h / 2, z = d / 2;
  const v = [[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]];
  const f = [
    { p: [3,7,6,2], c },   // top (+Y)
    { p: [1,5,4,0], c },   // bottom (-Y)
    { p: [5,6,7,4], c },   // front (+Z)
    { p: [0,3,2,1], c },   // back (-Z)
    { p: [1,2,6,5], c },   // right (+X)
    { p: [4,7,3,0], c },   // left (-X)
  ];
  return { v, f };
}
// Gear facing +Z: teeth around XY, extruded along Z.
function gearMesh(teeth, rOut, rRoot, thick, c, hubR = 0) {
  const v = [], f = [];
  const ring = [];
  const step = TAU / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step;
    // tooth profile: root -> flank -> tip -> flank -> root
    const prof = [[0, rRoot], [0.28, rOut], [0.55, rOut], [0.83, rRoot]];
    for (const [fa, r] of prof) {
      const an = a + fa * step;
      ring.push([Math.cos(an) * r, Math.sin(an) * r]);
    }
  }
  const n = ring.length, zt = thick / 2;
  for (const [x, y] of ring) { v.push([x, y, zt]); }
  for (const [x, y] of ring) { v.push([x, y, -zt]); }
  const col = (r, g, b) => [r, g, b];
  // top fan (around center)
  const cTop = v.length; v.push([0, 0, zt]);
  const cBot = v.length; v.push([0, 0, -zt]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    f.push({ p: [cTop, i, j], c: col(...c) });
    f.push({ p: [cBot, n + j, n + i], c: col(...c) });
    f.push({ p: [i, n + i, n + j], c: col(...c) });
    f.push({ p: [i, n + j, j], c: col(...c) });
  }
  const m = { v, f };
  if (hubR > 0) {
    // raised hub disc
    const hub = cylMesh(hubR, thick * 1.6, 18, shade(c, 1.15));
    m.v.push(...hub.v.map(p => p));
    const off = n * 2 + 2;
    for (const fc of hub.f) m.f.push({ p: fc.p.map(i => i + off), c: fc.c });
  }
  return m;
}
function cylMesh(r, h, seg, c) {
  const v = [], f = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    v.push([Math.cos(a) * r, h / 2, Math.sin(a) * r]);
    v.push([Math.cos(a) * r, -h / 2, Math.sin(a) * r]);
  }
  const ct = v.length; v.push([0, h / 2, 0]);
  const cb = v.length; v.push([0, -h / 2, 0]);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg, a = i * 2, b = j * 2;
    f.push({ p: [ct, b, a], c });       // top (+Y)
    f.push({ p: [cb, a + 1, b + 1], c }); // bottom (-Y)
    f.push({ p: [a, b, b + 1], c });     // sides (outward)
    f.push({ p: [a, b + 1, a + 1], c });
  }
  return { v, f };
}
// flat annulus (ring) in XZ plane — pit rims
function annulusMesh(rIn, rOut, seg, c) {
  const v = [], f = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    v.push([Math.cos(a) * rIn, 0, Math.sin(a) * rIn]);
    v.push([Math.cos(a) * rOut, 0, Math.sin(a) * rOut]);
  }
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg, a = i * 2, b = j * 2;
    f.push({ p: [a, b, b + 1], c });
    f.push({ p: [a, b + 1, a + 1], c });
  }
  return { v, f };
}
// flat disc in XZ plane — pit bowls
function discMesh(r, seg, c) {
  const v = [[0, 0, 0]], f = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * TAU;
    v.push([Math.cos(a) * r, 0, Math.sin(a) * r]);
  }
  for (let i = 1; i <= seg; i++) {
    const j = i % seg + 1;
    f.push({ p: [0, j, i], c });
  }
  return { v, f };
}
function shade(c, k) { return [clamp(c[0] * k, 0, 255) | 0, clamp(c[1] * k, 0, 255) | 0, clamp(c[2] * k, 0, 255) | 0]; }
function css(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }

/* ============================== renderer ============================== */
const LIGHT = norm3([-0.45, 0.8, 0.55]);
const RIM = norm3([0.5, 0.2, -0.7]);
let eclipseDim = 0; // 0..1 darkens the scene during eclipses

// instances: { mesh, pos:[x,y,z], ry, rx, rz, tint:[r,g,b]|null, view }
function drawBackground() {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  const dim = 1 - eclipseDim * 0.75;
  g.addColorStop(0, `rgb(${11 * dim | 0},${14 * dim | 0},${26 * dim | 0})`);
  g.addColorStop(0.6, `rgb(${7 * dim | 0},${8 * dim | 0},${18 * dim | 0})`);
  g.addColorStop(1, `rgb(${5 * dim | 0},${6 * dim | 0},${13 * dim | 0})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  drawStars(dim);
}
// 3D pass only (no background); view filters 'clock' | 'board'
function renderScene(instances, B, view) {
  const dim = 1 - eclipseDim * 0.75;
  const tris = [];
  for (const inst of instances) {
    if (inst.view !== view && inst.view !== "both") continue;
    const { mesh, pos } = inst;
    const wv = new Array(mesh.v.length);
    for (let i = 0; i < mesh.v.length; i++) {
      const r = rotYX(mesh.v[i], inst.ry || 0, inst.rx || 0, inst.rz || 0);
      wv[i] = [r[0] + pos[0], r[1] + pos[1], r[2] + pos[2]];
    }
    for (const fc of mesh.f) {
      const p0 = wv[fc.p[0]], p1 = wv[fc.p[1]], p2 = wv[fc.p[2]];
      const n = norm3(cross3(sub3(p1, p0), sub3(p2, p0)));
      // backface cull (faces pointing away from camera)
      const toCam = norm3(sub3(cam.pos, p0));
      if (dot3(n, toCam) <= 0.02) continue;
      let z = 0; const sp = [];
      let ok = true;
      for (const pi of fc.p) {
        const s = project(wv[pi], B);
        if (!s) { ok = false; break; }
        sp.push(s); z += s[2];
      }
      if (!ok) continue;
      const dl = Math.max(0, dot3(n, LIGHT));
      const rl = Math.max(0, dot3(n, RIM)) * 0.35;
      let base = fc.c;
      if (inst.tint) base = shade(inst.tint, 1);
      const k = (0.32 + 0.68 * dl + rl) * dim;
      tris.push({ sp, z: z / fc.p.length, c: shade(base, k) });
    }
  }
  tris.sort((a, b) => b.z - a.z);
  ctx.lineWidth = 1;
  for (const t of tris) {
    ctx.beginPath();
    ctx.moveTo(t.sp[0][0], t.sp[0][1]);
    for (let i = 1; i < t.sp.length; i++) ctx.lineTo(t.sp[i][0], t.sp[i][1]);
    ctx.closePath();
    ctx.fillStyle = css(t.c);
    ctx.fill();
  }
}

// starfield (2D, twinkles)
const stars = [];
for (let i = 0; i < 140; i++) {
  stars.push({ x: Math.random(), y: Math.random() * 0.7, r: Math.random() * 1.3 + 0.3, p: Math.random() * TAU, s: 0.5 + Math.random() * 1.5 });
}
let starT = 0;
function drawStars(dim) {
  starT += 0.016;
  ctx.fillStyle = "#fff";
  for (const s of stars) {
    const tw = REDUCED ? 0.7 : 0.45 + 0.35 * Math.sin(starT * s.s + s.p);
    ctx.globalAlpha = tw * dim;
    ctx.fillRect(s.x * W, s.y * H, s.r, s.r);
  }
  ctx.globalAlpha = 1;
}
/* ============================== audio ============================== */
const Audio2 = {
  ctx: null, muted: false, drone: null,
  init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.startDrone();
    } catch (e) { /* no audio */ }
  },
  toggle() { this.muted = !this.muted; return this.muted; },
  now() { return this.ctx ? this.ctx.currentTime : 0; },
  env(g, t0, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  },
  tone(freq, { type = "sine", a = 0.005, d = 0.25, peak = 0.2, slide = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.now(), o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + a + d);
    this.env(g, t0, a, peak, d);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0); o.stop(t0 + a + d + 0.05);
  },
  noise({ d = 0.1, peak = 0.15, fc = 2000, q = 1 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.now(), len = Math.max(1, (d + 0.05) * this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const f = this.ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = fc; f.Q.value = q;
    const g = this.ctx.createGain(); this.env(g, t0, 0.004, peak, d);
    src.connect(f).connect(g).connect(this.ctx.destination);
    src.start(t0);
  },
  // named sounds
  tick(i) { // seed drop; pitch climbs with pit index
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
    const f = 340 * Math.pow(2, (scale[i % 13] || 0) / 12);
    this.tone(f, { type: "triangle", d: 0.12, peak: 0.16 });
    this.noise({ d: 0.03, peak: 0.05, fc: 5200, q: 2 });
  },
  gear() { this.tone(140 + Math.random() * 30, { type: "square", d: 0.05, peak: 0.05 }); this.noise({ d: 0.04, peak: 0.06, fc: 900, q: 1.5 }); },
  capture() { [523, 659, 784].forEach((f, i) => setTimeout(() => this.tone(f, { type: "triangle", d: 0.18, peak: 0.18 }), i * 70)); },
  gong() {
    if (!this.ctx || this.muted) return;
    const t0 = this.now();
    [110, 110 * 2.76, 110 * 5.4].forEach((f, i) => {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      this.env(g, t0, 0.01, [0.3, 0.12, 0.06][i], 2.4);
      o.connect(g).connect(this.ctx.destination); o.start(t0); o.stop(t0 + 2.6);
    });
    this.noise({ d: 1.2, peak: 0.04, fc: 6000, q: 0.7 });
  },
  eclipse() {
    this.tone(150, { type: "sine", d: 1.2, peak: 0.35, slide: -100 });
    this.tone(75, { type: "sine", d: 1.6, peak: 0.25, slide: -40 });
    setTimeout(() => this.noise({ d: 1.5, peak: 0.05, fc: 8000, q: 0.6 }), 200);
  },
  win() { [392, 494, 587, 784, 988].forEach((f, i) => setTimeout(() => this.tone(f, { type: "triangle", d: 0.3, peak: 0.16 }), i * 130)); },
  lose() { [330, 262, 196].forEach((f, i) => setTimeout(() => this.tone(f, { type: "triangle", d: 0.4, peak: 0.14 }), i * 180)); },
  startDrone() {
    const c = this.ctx; if (!c) return;
    const g = c.createGain(); g.gain.value = 0.035; g.connect(c.destination);
    [55, 55 * 1.5, 110.3].forEach((f) => {
      const o = c.createOscillator(); o.type = "sine"; o.frequency.value = f;
      o.connect(g); o.start();
    });
    const lfo = c.createOscillator(), lg = c.createGain();
    lfo.frequency.value = 0.07; lg.gain.value = 0.015;
    lfo.connect(lg).connect(g.gain); lfo.start();
    this.drone = g;
  },
};

/* ============================== game + time state ============================== */
const G = {
  state: null,           // mancala state from game.js
  animating: false,
  started: false,
  // time system: grains sown -> moons -> omens
  grains: 0,             // grains sown this moon
  moon: 1,
  moons: 0,              // completed moons
  eclipseArmed: false,   // next capture x2
  eclipseRounds: 0,      // great-eclipse rounds remaining
  MOON_LEN: 24,
  omens: ["eclipse", "bloom", "harvest", "oracle"],
  omenIdx: 0,
  // gear angles
  gearMain: 0, gearMainTarget: 0, gearVel: 0, clockKick: 0,
  celestial: false, // exploration mode: clock reads the real sky
  saros: 0,              // 0..1, full turn per 3 moons
  paused: false,
};

const OMEN_INFO = {
  eclipse: { glyph: "◍", title: "ECLIPSE OMEN", text: "The next capture is doubled." },
  bloom: { glyph: "❀", title: "BLOOM", text: "A grain appears in each of your houses." },
  harvest: { glyph: "◈", title: "HARVEST", text: "+2 grains to your granary." },
  oracle: { glyph: "☄", title: "ORACLE", text: "The mechanism grants you another turn." },
  great: { glyph: "🌑", title: "GREAT ECLIPSE", text: "The sun is devoured — all captures doubled for a full round." },
  olympiad: { glyph: "🏛", title: "OLYMPIAD", text: "Four years turn — a grain for every house on the wheel." },
};

function showOmen(kind) {
  const info = OMEN_INFO[kind];
  document.getElementById("omen-glyph").textContent = info.glyph;
  document.getElementById("omen-title").textContent = info.title;
  document.getElementById("omen-text").textContent = info.text;
  const b = document.getElementById("omen-banner");
  b.classList.remove("hidden");
  clearTimeout(showOmen._t);
  showOmen._t = setTimeout(() => b.classList.add("hidden"), 2600);
}

function setBanner(t) { document.getElementById("turn-banner").textContent = t; }
function updateHud() {
  const [a, b] = scores(G.state);
  document.getElementById("score-you").textContent = a;
  document.getElementById("score-foe").textContent = b;
  document.getElementById("grain-fill").style.width = (G.grains / G.MOON_LEN * 100) + "%";
  document.getElementById("grain-count").textContent = G.grains + "/" + G.MOON_LEN;
  document.getElementById("month-label").textContent = "Moon " + G.moon;
  const phases = ["☽", "☾", "◍", "☀"];
  document.getElementById("moon-phase").textContent = phases[Math.floor(G.grains / G.MOON_LEN * 4) % 4];
}
/* ============================== celestial mode ============================== */
// Real-sky astronomy for the exploration mode: sun/moon longitudes, local
// sidereal time, and a bright-star catalog for the planisphere.
const OBS_LAT = 40 * Math.PI / 180;   // 40°N
const OBS_LON = -75;                   // 75°W (US East)
const OBLIQ = 23.439 * Math.PI / 180;  // obliquity of the ecliptic
// [name, RA hours, Dec degrees, magnitude]
const STARS = [
  ["Sirius", 6.752, -16.716, -1.5], ["Canopus", 6.399, -52.696, -0.7],
  ["Arcturus", 14.261, 19.182, -0.1], ["Vega", 18.616, 38.784, 0.0],
  ["Capella", 5.278, 45.998, 0.1], ["Rigel", 5.242, -8.202, 0.1],
  ["Procyon", 7.655, 5.225, 0.3], ["Betelgeuse", 5.919, 7.407, 0.4],
  ["Altair", 19.846, 8.868, 0.8], ["Aldebaran", 4.599, 16.509, 0.9],
  ["Antares", 16.490, -26.432, 1.0], ["Spica", 13.420, -11.161, 1.0],
  ["Pollux", 7.755, 28.027, 1.1], ["Fomalhaut", 22.960, -29.622, 1.2],
  ["Deneb", 20.690, 45.280, 1.3], ["Regulus", 10.140, 11.967, 1.4],
  ["Castor", 7.577, 31.888, 1.6], ["Bellatrix", 5.418, 6.350, 1.6],
  ["Elnath", 5.438, 28.608, 1.7], ["Alnilam", 5.606, -1.202, 1.7],
  ["Alnitak", 5.679, -1.943, 1.7], ["Saiph", 5.796, -9.670, 2.1],
  ["Mintaka", 5.534, -0.299, 2.2], ["Polaris", 2.530, 89.264, 2.0],
  ["Dubhe", 11.062, 61.751, 1.8], ["Merak", 11.031, 56.382, 2.4],
  ["Phecda", 11.897, 53.695, 2.4], ["Megrez", 12.257, 57.033, 3.3],
  ["Alioth", 12.911, 55.960, 1.8], ["Mizar", 13.399, 54.925, 2.3],
  ["Alkaid", 13.792, 49.313, 1.9], ["Caph", 0.153, 59.150, 2.3],
  ["Schedar", 0.675, 56.537, 2.2], ["Gamma Cas", 0.945, 60.717, 2.5],
  ["Ruchbah", 1.430, 60.235, 2.7], ["Segin", 1.907, 63.670, 3.4],
  ["Sadr", 20.370, 40.257, 2.2], ["Albireo", 19.512, 27.959, 3.2],
  ["Tarazed", 19.771, 10.613, 2.7], ["Alshain", 19.811, 6.407, 3.7],
  ["Enif", 21.736, 9.875, 2.4], ["Markab", 23.079, 15.205, 2.5],
  ["Scheat", 23.063, 28.083, 2.4], ["Alpheratz", 0.140, 29.091, 2.1],
  ["Mirach", 1.162, 35.620, 2.1], ["Algol", 3.136, 40.957, 2.1],
  ["Mirfak", 3.405, 49.861, 1.8], ["Hamal", 2.120, 23.463, 2.0],
  ["Diphda", 0.731, -17.989, 2.0], ["Menkar", 3.037, 4.090, 2.5],
  ["Alcyone", 3.790, 24.117, 2.9], ["Algenib", 0.220, 15.183, 2.8],
  ["Denebola", 11.818, 14.572, 2.1], ["Zosma", 11.235, 20.524, 2.6],
  ["Ras Alhague", 17.582, 12.560, 2.1], ["Sabik", 17.165, -15.725, 2.4],
  ["Graffias", 16.091, -19.805, 2.6], ["Dschubba", 16.005, -22.622, 2.3],
];
// constellation line segments (by star name)
const CONSTELLATIONS = [
  { name: "ORION", lines: [["Betelgeuse", "Alnitak"], ["Bellatrix", "Mintaka"], ["Alnitak", "Alnilam"], ["Alnilam", "Mintaka"], ["Alnitak", "Saiph"], ["Mintaka", "Rigel"], ["Alnitak", "Rigel"]] },
  { name: "URSA MAJOR", lines: [["Dubhe", "Merak"], ["Merak", "Phecda"], ["Phecda", "Megrez"], ["Megrez", "Dubhe"], ["Megrez", "Alioth"], ["Alioth", "Mizar"], ["Mizar", "Alkaid"]] },
  { name: "CASSIOPEIA", lines: [["Caph", "Schedar"], ["Schedar", "Gamma Cas"], ["Gamma Cas", "Ruchbah"], ["Ruchbah", "Segin"]] },
  { name: "CYGNUS", lines: [["Deneb", "Sadr"], ["Sadr", "Albireo"]] },
  { name: "AQUILA", lines: [["Altair", "Tarazed"], ["Altair", "Alshain"]] },
  { name: "SCORPIUS", lines: [["Antares", "Graffias"], ["Graffias", "Dschubba"], ["Antares", "Sabik"]] },
  { name: "LEO", lines: [["Regulus", "Denebola"], ["Regulus", "Algieba"]] },
  { name: "GEMINI", lines: [["Castor", "Pollux"]] },
  { name: "CANIS MAJOR", lines: [["Sirius", "Mirzam"]] },
  { name: "PEGASUS", lines: [["Markab", "Scheat"], ["Scheat", "Algenib"], ["Markab", "Alpheratz"]] },
  { name: "TAURUS", lines: [["Aldebaran", "Elnath"], ["Aldebaran", "Alcyone"]] },
];
const STAR_BY_NAME = {};
for (const s of STARS) STAR_BY_NAME[s[0]] = s;
STAR_BY_NAME["Sheliak"] = ["Sheliak", 18.834, 33.363, 3.5];
STAR_BY_NAME["Mirzam"] = ["Mirzam", 6.378, -17.955, 2.0];
STAR_BY_NAME["Algieba"] = ["Algieba", 10.333, 19.842, 2.1];

function nowInfo() {
  const now = new Date();
  const d = (now.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000; // days since J2000
  const L = (280.460 + 0.9856474 * d) % 360;                      // sun mean longitude
  const g = (357.528 + 0.9856003 * d) % 360 * Math.PI / 180;      // sun mean anomaly
  const sunLon = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g) + 360) % 360;
  const synodic = 29.530588853;
  const newMoon2000 = Date.UTC(2000, 0, 6, 18, 14);
  const phase = (((now.getTime() - newMoon2000) / 86400000 / synodic) % 1 + 1) % 1;
  const moonLon = (218.316 + 13.176396 * d) % 360;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  const lst = (((gmst + OBS_LON) % 360 + 360) % 360) / 15;
  const signs = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
  return { now, sunLon, moonLon, phase, lst, sign: signs[Math.floor(sunLon / 30) % 12] };
}
// ecliptic longitude (deg) -> [RA hours, Dec deg]
function eclToRaDec(lonDeg) {
  const lon = lonDeg * Math.PI / 180;
  const ra = Math.atan2(Math.sin(lon) * Math.cos(OBLIQ), Math.cos(lon));
  const dec = Math.asin(Math.sin(lon) * Math.sin(OBLIQ));
  return [((ra * 180 / Math.PI / 15) % 24 + 24) % 24, dec * 180 / Math.PI];
}
// RA hours, Dec deg -> [altitude, azimuth] radians (az from north, eastward)
function raDecToAltAz(raH, decD, lstH) {
  const ra = raH * 15 * Math.PI / 180, dec = decD * Math.PI / 180;
  let ha = (lstH * 15 * Math.PI / 180 - ra) % (2 * Math.PI);
  if (ha > Math.PI) ha -= 2 * Math.PI; if (ha < -Math.PI) ha += 2 * Math.PI;
  const sinAlt = Math.sin(dec) * Math.sin(OBS_LAT) + Math.cos(dec) * Math.cos(OBS_LAT) * Math.cos(ha);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(OBS_LAT)) / (Math.cos(alt) * Math.cos(OBS_LAT));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (Math.sin(ha) > 0) az = 2 * Math.PI - az;
  return [alt, az];
}

/* ============================== scene ============================== */
const BRONZE = [176, 141, 87], BRONZE_DK = [122, 96, 58], VERDI = [67, 179, 162];
const STONE = [52, 56, 72], STONE_DK = [30, 33, 44], BOWL = [20, 23, 34];
const AMBER = [255, 179, 71];

// board layout (world units, board top at y=0)
const PIT_X = (i) => -4.5 + i * 1.8;
const ROW_Z = { you: 1.15, foe: -1.15 };
const STORE_X = 6.3;
function pitPos(idx) {
  if (idx === 6) return [STORE_X, 0, 0];
  if (idx === 13) return [-STORE_X, 0, 0];
  if (idx < 6) return [PIT_X(idx), 0, ROW_Z.you];
  return [PIT_X(idx - 7), 0, ROW_Z.foe];
}

const instances = [];
let buildView = "both"; // set while building board vs clock
function addInst(mesh, pos, opts = {}) {
  const inst = { mesh, pos, ry: opts.ry || 0, rx: opts.rx || 0, rz: opts.rz || 0, tint: opts.tint || null, view: opts.view || buildView };
  instances.push(inst); return inst;
}
// hand: thin box pivoting at its base (extends +Y), for clock hands
function handMesh(len, wid, color) {
  const m = boxMesh(wid, len, 0.07, color);
  m.v = m.v.map(p => [p[0], p[1] + len / 2, p[2]]);
  return m;
}

function buildBoard() {
  buildView = "board";
  // basalt slab + bronze base trim
  addInst(boxMesh(14.6, 0.7, 5.6, STONE), [0, -0.36, 0]);
  addInst(boxMesh(15.2, 0.22, 6.2, BRONZE_DK), [0, -0.78, 0]);
  // pit rims + bowls
  const rim = annulusMesh(0.62, 0.8, 20, BRONZE);
  const bowl = discMesh(0.62, 20, BOWL);
  const sRim = annulusMesh(0.85, 1.08, 24, BRONZE);
  const sBowl = discMesh(0.85, 24, BOWL);
  for (let i = 0; i < 14; i++) {
    if (i === 6 || i === 13) continue;
    const [x, , z] = pitPos(i);
    addInst(rim, [x, 0.02, z]); addInst(bowl, [x, 0.0, z]);
  }
  for (const s of [6, 13]) {
    const [x, , z] = pitPos(s);
    addInst(sRim, [x, 0.02, z]); addInst(sBowl, [x, 0.0, z]);
  }
  // corner studs
  const stud = cylMesh(0.16, 0.3, 10, BRONZE);
  for (const [x, z] of [[-7, -2.6], [7, -2.6], [-7, 2.6], [7, 2.6]]) addInst(stud, [x, 0.1, z]);
  buildView = "both";
}

// --- the mechanism: an astronomical clock ---
// One input (the sowing) drives the whole train. The moon wheel turns once
// per moon; the sun hand is geared 12:1 (once per year); the saros pointer
// turns once per 3 moons. Satellites mesh with the main wheel at true ratios.
const gears = [];
const WHEEL = { x: 0, y: 5.2, z: -7.8, pitch: 3.24 };
// sun hand angle: one revolution per 12 moons
function sunAngle() {
  return ((G.moons + G.grains / G.MOON_LEN) / 12) * TAU;
}
// lunar angle: one revolution per moon — the true moon hand (independent of
// the main wheel, which spins faster for drama)
function lunarAngle() {
  return (G.moons + G.grains / G.MOON_LEN) * TAU;
}
function buildMechanism() {
  buildView = "clock";
  // FIXED zodiac ring — the clock face (does not rotate)
  const ring = annulusMesh(3.65, 4.08, 64, BRONZE_DK);
  addInst(ring, [WHEEL.x, WHEEL.y, WHEEL.z], { rx: Math.PI / 2 });
  const bezel = annulusMesh(3.5, 3.62, 64, BRONZE);
  addInst(bezel, [WHEEL.x, WHEEL.y, WHEEL.z + 0.3], { rx: Math.PI / 2 });
  // FIXED Taoist bagua ring — eight trigrams, outermost (does not rotate)
  const baguaRing = annulusMesh(4.16, 4.52, 72, shade(BRONZE_DK, 0.72));
  addInst(baguaRing, [WHEEL.x, WHEEL.y, WHEEL.z - 0.06], { rx: Math.PI / 2 });

  // main moon wheel (48T) — one revolution per moon
  const main = gearMesh(48, 3.5, 2.98, 0.5, BRONZE, 0.7);
  const g0 = addInst(main, [WHEEL.x, WHEEL.y, WHEEL.z], {});
  gears.push({ inst: g0, ratio: 1, phase: 0, kind: "main" });
  // spokes so the wheel's turning reads clearly
  for (let s = 0; s < 4; s++) {
    const spoke = handMesh(2.85, 0.15, shade(BRONZE, 0.8));
    const si = addInst(spoke, [WHEEL.x, WHEEL.y, WHEEL.z + 0.28], {});
    gears.push({ inst: si, kind: "spoke", off: s * Math.PI / 2 });
  }

  // moon hand (silver) — rides the moon wheel, tip carries the phase disc
  const mh = addInst(handMesh(3.1, 0.13, [205, 215, 230]), [WHEEL.x, WHEEL.y, WHEEL.z + 0.38], {});
  gears.push({ inst: mh, kind: "moonHand" });
  // sun hand (golden) — geared down 12:1, one revolution per year
  const sh = addInst(handMesh(3.35, 0.17, [235, 185, 85]), [WHEEL.x, WHEEL.y, WHEEL.z + 0.48], {});
  gears.push({ inst: sh, kind: "sunHand" });
  // center cap
  const cap = addInst(cylMesh(0.3, 0.2, 16, BRONZE), [WHEEL.x, WHEEL.y, WHEEL.z + 0.55], { rx: Math.PI / 2 });
  void cap;

  // satellite gears meshing with the main wheel (true ratios, counter-rotating)
  const sats = [
    { t: 16, ang: 200 * Math.PI / 180 },
    { t: 12, ang: -20 * Math.PI / 180 },
    { t: 20, ang: 65 * Math.PI / 180 },
  ];
  for (const s of sats) {
    const r = WHEEL.pitch * (s.t / 48);
    const d = WHEEL.pitch + r;
    const g = gearMesh(s.t, r * 1.08, r * 0.92, 0.4, s.t === 12 ? VERDI : BRONZE_DK, r * 0.32);
    const inst = addInst(g, [WHEEL.x + Math.cos(s.ang) * d, WHEEL.y + Math.sin(s.ang) * d, WHEEL.z], {});
    gears.push({ inst, ratio: -48 / s.t, phase: Math.PI / s.t, kind: "sat" });
  }

  // saros eclipse pointer — one revolution per 3 moons
  const arm = handMesh(2.2, 0.12, VERDI);
  const pointer = addInst(arm, [WHEEL.x, WHEEL.y, WHEEL.z + 0.58], {});
  gears.push({ inst: pointer, kind: "saros" });
  const eye = cylMesh(0.32, 0.16, 16, [20, 22, 34]);
  const eyeI = addInst(eye, [0, 0, 0], { rx: Math.PI / 2 });
  gears.push({ inst: eyeI, kind: "sarosEye" });
  buildView = "both";
  // (the clock floats; no pedestal — it is a dream of bronze)
}

// clock face: fixed calendar rings — astrological symbols + Greek alphabet,
// Taoist bagua, Kongolese dikenga — plus the sun/moon discs and saros eye.
// The rings never turn; the hands do.
const ASTRO = ["♈︎","♉︎","♊︎","♋︎","♌︎","♍︎","♎︎","♏︎","♐︎","♑︎","♒︎","♓︎"];
const GREEK = ["Α","Β","Γ","Δ","Ε","Ζ","Η","Θ","Ι","Κ","Λ","Μ","Ν","Ξ","Ο","Π","Ρ","Σ","Τ","Υ","Φ","Χ","Ψ","Ω"];
const BAGUA = ["☰", "☱", "☲", "☳", "☴", "☵", "☶", "☷"];
// dikenga: four moments of the sun (Kongo cosmogram). Angles in the wheel
// plane: 90°=top. Colors: kala=black/dawn, tukula=red/noon,
// luvemba=white/sunset, musoni=yellow/midnight.
const DIKENGA = [
  { name: "KALA", a0: 45 * Math.PI / 180, a1: 135 * Math.PI / 180, c: "#4a4a4a", lc: "#9a9a9a" },
  { name: "TUKULA", a0: -45 * Math.PI / 180, a1: 45 * Math.PI / 180, c: "#b03a2a", lc: "#d06a5a" },
  { name: "LUVEMBA", a0: 225 * Math.PI / 180, a1: 315 * Math.PI / 180, c: "#d8d8d8", lc: "#e8e8e8" },
  { name: "MUSONI", a0: 135 * Math.PI / 180, a1: 225 * Math.PI / 180, c: "#c9971f", lc: "#d9ab3a" },
];
function strokeArc3D(B, cx, cy, cz, r, a0, a1, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath();
  let started = false;
  for (let a = a0; a <= a1 + 0.001; a += 0.06) {
    const p = project([cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz], B);
    if (!p) continue;
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}
function drawZodiac(B) {
  const dim = 1 - eclipseDim * 0.6;
  // 48 tick marks around the fixed ring
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU;
    const major = i % 4 === 0;
    const r1 = major ? 3.6 : 3.74, r2 = 4.1;
    const p1 = project([WHEEL.x + Math.cos(a) * r1, WHEEL.y + Math.sin(a) * r1, WHEEL.z + 0.08], B);
    const p2 = project([WHEEL.x + Math.cos(a) * r2, WHEEL.y + Math.sin(a) * r2, WHEEL.z + 0.08], B);
    if (!p1 || !p2) continue;
    ctx.strokeStyle = `rgba(215,175,95,${(major ? 0.95 : 0.45) * dim})`;
    ctx.lineWidth = major ? 2.5 : 1;
    ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
  }
  // astrological symbols on the zodiac ring (fixed) — force text presentation
  ctx.font = "20px 'Segoe UI Symbol','Noto Sans Symbols 2','DejaVu Sans',sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU + TAU / 24;
    const p = project([WHEEL.x + Math.cos(a) * 3.87, WHEEL.y + Math.sin(a) * 3.87, WHEEL.z + 0.08], B);
    if (!p) continue;
    ctx.fillStyle = `rgba(242,224,165,${0.98 * dim})`;
    ctx.fillText(ASTRO[i], p[0], p[1]);
  }
  // the Greek alphabet — 24 letters on the bezel (fixed)
  ctx.font = "600 10px Georgia, serif";
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU + TAU / 48;
    const p = project([WHEEL.x + Math.cos(a) * 3.56, WHEEL.y + Math.sin(a) * 3.56, WHEEL.z + 0.32], B);
    if (!p) continue;
    ctx.fillStyle = `rgba(216,196,140,${0.85 * dim})`;
    ctx.fillText(GREEK[i], p[0], p[1]);
  }
  // Taoist bagua: eight trigrams on the outer ring (fixed)
  ctx.font = "20px Georgia, serif";
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU + TAU / 16;
    const p = project([WHEEL.x + Math.cos(a) * 4.34, WHEEL.y + Math.sin(a) * 4.34, WHEEL.z], B);
    if (!p) continue;
    ctx.fillStyle = `rgba(168,205,190,${0.92 * dim})`;
    ctx.fillText(BAGUA[i], p[0], p[1]);
  }
  // Kongolese dikenga: the cross of the four sun-moments (fixed overlay)
  const dz = WHEEL.z + 0.14;
  ctx.strokeStyle = `rgba(200,190,170,${0.35 * dim})`; ctx.lineWidth = 1;
  {
    const t = project([WHEEL.x, WHEEL.y + 2.95, dz], B), b = project([WHEEL.x, WHEEL.y - 2.95, dz], B);
    const l = project([WHEEL.x - 2.95, WHEEL.y, dz], B), r = project([WHEEL.x + 2.95, WHEEL.y, dz], B);
    if (t && b) { ctx.beginPath(); ctx.moveTo(t[0], t[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); }
    if (l && r) { ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(r[0], r[1]); ctx.stroke(); }
  }
  for (const m of DIKENGA) {
    strokeArc3D(B, WHEEL.x, WHEEL.y, dz, 2.82, m.a0, m.a1, m.c, 5);
    const la = (m.a0 + m.a1) / 2;
    const lp = project([WHEEL.x + Math.cos(la) * 2.38, WHEEL.y + Math.sin(la) * 2.38, dz], B);
    if (lp) {
      ctx.font = "600 9px Georgia, serif";
      ctx.fillStyle = m.lc;
      ctx.fillText(m.name, lp[0], lp[1]);
    }
  }
  // sun disc at the sun hand's tip (golden, rayed)
  const sa = sunAngle();
  const sp = project([WHEEL.x + Math.cos(sa) * 3.35, WHEEL.y + Math.sin(sa) * 3.35, WHEEL.z + 0.5], B);
  if (sp) {
    ctx.strokeStyle = `rgba(255,200,90,${0.85 * dim})`; ctx.lineWidth = 2;
    for (let r = 0; r < 8; r++) {
      const ra = (r / 8) * TAU + sa;
      ctx.beginPath();
      ctx.moveTo(sp[0] + Math.cos(ra) * 11, sp[1] + Math.sin(ra) * 11);
      ctx.lineTo(sp[0] + Math.cos(ra) * 17, sp[1] + Math.sin(ra) * 17);
      ctx.stroke();
    }
    const grd = ctx.createRadialGradient(sp[0], sp[1], 0, sp[0], sp[1], 13);
    grd.addColorStop(0, `rgba(255,232,155,${dim})`);
    grd.addColorStop(1, "rgba(255,180,60,0)");
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], 13, 0, TAU); ctx.fill();
    ctx.fillStyle = `rgba(255,214,115,${dim})`;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], 7, 0, TAU); ctx.fill();
  }
  // moon disc at the moon hand's tip, shaded by the true phase
  // (in celestial mode: the real moon's longitude and phase)
  const celInfo = G.celestial ? nowInfo() : null;
  const ma = celInfo ? celInfo.moonLon * Math.PI / 180 : lunarAngle();
  const mphase = celInfo ? celInfo.phase : (G.grains / G.MOON_LEN) % 1;
  const mp = project([WHEEL.x + Math.cos(ma) * 3.1, WHEEL.y + Math.sin(ma) * 3.1, WHEEL.z + 0.4], B);
  if (mp) {
    const phase = mphase; // 0 = new, 0.5 = full
    const bright = Math.sin(phase * Math.PI);
    ctx.fillStyle = "rgba(28,30,42,0.95)";
    ctx.beginPath(); ctx.arc(mp[0], mp[1], 9, 0, TAU); ctx.fill();
    const mb = Math.round(60 + 170 * bright);
    ctx.fillStyle = `rgba(${mb},${mb},${Math.min(255, mb + 12)},${0.95 * dim})`;
    ctx.beginPath(); ctx.arc(mp[0], mp[1], 3 + 6 * bright, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(205,215,230,${0.7 * dim})`; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(mp[0], mp[1], 9, 0, TAU); ctx.stroke();
  }
  // saros eclipse eye — larger, crowned with a corona
  const ea = G.saros * TAU;
  const ep = project([WHEEL.x + Math.cos(ea) * 2.2, WHEEL.y + Math.sin(ea) * 2.2, WHEEL.z + 0.6], B);
  if (ep) {
    ctx.fillStyle = "rgba(14,14,24,0.96)";
    ctx.beginPath(); ctx.arc(ep[0], ep[1], 10, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(255,179,71,${0.95 * dim})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ep[0], ep[1], 13, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(255,179,71,${0.35 * dim})`; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ep[0], ep[1], 18, 0, TAU); ctx.stroke();
  }
}

// planisphere star chart (2D, drawn in the board viewport)
function drawStarChart(info) {
  const cx = VX + VW / 2, cy = VY + VH / 2;
  const R = Math.min(VW, VH) * 0.44;
  const dim = 1 - eclipseDim * 0.6;
  // chart disc
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, `rgba(16,22,44,${0.96 * dim})`);
  g.addColorStop(1, `rgba(8,10,24,${0.96 * dim})`);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = `rgba(216,164,116,${0.5 * dim})`; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  // project alt/az to chart (zenith center, horizon rim, north up)
  const toXY = (alt, az) => {
    const r = (1 - alt / (Math.PI / 2)) * R;
    return [cx + r * Math.sin(az), cy - r * Math.cos(az)];
  };
  // cardinal labels
  ctx.font = "600 11px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = `rgba(216,196,140,${0.8 * dim})`;
  const cards = [["N", 0], ["E", Math.PI / 2], ["S", Math.PI], ["W", 3 * Math.PI / 2]];
  for (const [t, az] of cards) {
    ctx.fillText(t, cx + (R + 14) * Math.sin(az), cy - (R + 14) * Math.cos(az));
  }
  // ecliptic (dashed)
  ctx.strokeStyle = `rgba(242,224,165,${0.35 * dim})`; ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  let started = false;
  for (let lon = 0; lon <= 360; lon += 4) {
    const [ra, dec] = eclToRaDec(lon);
    const [alt, az] = raDecToAltAz(ra, dec, info.lst);
    if (alt <= 0) { started = false; continue; }
    const [x, y] = toXY(alt, az);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.setLineDash([]);
  // constellation lines
  ctx.strokeStyle = `rgba(120,150,190,${0.4 * dim})`; ctx.lineWidth = 1;
  for (const c of CONSTELLATIONS) {
    for (const [a, b] of c.lines) {
      const sa = STAR_BY_NAME[a], sb = STAR_BY_NAME[b];
      if (!sa || !sb) continue;
      const [alt1, az1] = raDecToAltAz(sa[1], sa[2], info.lst);
      const [alt2, az2] = raDecToAltAz(sb[1], sb[2], info.lst);
      if (alt1 <= 0 || alt2 <= 0) continue;
      const [x1, y1] = toXY(alt1, az1), [x2, y2] = toXY(alt2, az2);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
  }
  // stars
  for (const [name, ra, dec, mag] of STARS) {
    const [alt, az] = raDecToAltAz(ra, dec, info.lst);
    if (alt <= 0) continue;
    const [x, y] = toXY(alt, az);
    const r = Math.max(0.8, 3.2 - mag * 0.75);
    ctx.fillStyle = `rgba(235,240,255,${Math.min(1, 0.55 + (2.5 - mag) * 0.25) * dim})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    if (mag < 1.2) {
      ctx.font = "9px Georgia, serif";
      ctx.fillStyle = `rgba(200,210,230,${0.75 * dim})`;
      ctx.fillText(name, x + r + 5, y - r - 3);
    }
  }
  // sun on the ecliptic
  {
    const [ra, dec] = eclToRaDec(info.sunLon);
    const [alt, az] = raDecToAltAz(ra, dec, info.lst);
    if (alt > 0) {
      const [x, y] = toXY(alt, az);
      ctx.fillStyle = `rgba(242,200,90,${0.95 * dim})`;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill();
      ctx.font = "11px Georgia, serif"; ctx.fillStyle = `rgba(242,200,90,${0.9 * dim})`;
      ctx.fillText("☉", x, y - 13);
    }
  }
  // moon on the ecliptic, true phase
  {
    const [ra, dec] = eclToRaDec(info.moonLon);
    const [alt, az] = raDecToAltAz(ra, dec, info.lst);
    if (alt > 0) {
      const [x, y] = toXY(alt, az);
      const bright = Math.sin(info.phase * Math.PI);
      ctx.fillStyle = `rgba(30,32,46,${0.95 * dim})`;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgba(220,225,235,${(0.25 + 0.7 * bright) * dim})`;
      ctx.beginPath(); ctx.arc(x, y, 2 + 4 * bright, 0, TAU); ctx.fill();
      ctx.font = "11px Georgia, serif";
      ctx.fillText("☽", x, y - 13);
    }
  }
  // caption
  ctx.font = "600 12px Georgia, serif";
  ctx.fillStyle = `rgba(216,196,140,${0.9 * dim})`;
  const lstH = Math.floor(info.lst), lstM = Math.floor((info.lst - lstH) * 60);
  ctx.fillText(`PLANISPHERE · 40°N 75°W · LST ${lstH}h${String(lstM).padStart(2, "0")}m`, cx, cy + R + 18);
}
// celestial overlay on the clock: 24h hand, true sun/moon, readout
function drawCelestialClock(B, info) {
  const dim = 1 - eclipseDim * 0.6;
  // 24 hour ticks (fixed)
  ctx.strokeStyle = `rgba(168,205,190,${0.5 * dim})`; ctx.lineWidth = 1;
  for (let h = 0; h < 24; h++) {
    const a = Math.PI / 2 - (h / 24) * TAU;
    const p1 = project([WHEEL.x + Math.cos(a) * 3.28, WHEEL.y + Math.sin(a) * 3.28, WHEEL.z + 0.15], B);
    const p2 = project([WHEEL.x + Math.cos(a) * 3.44, WHEEL.y + Math.sin(a) * 3.44, WHEEL.z + 0.15], B);
    if (p1 && p2) { ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke(); }
  }
  // 24h hand (local time)
  const hrs = info.now.getHours() + info.now.getMinutes() / 60 + info.now.getSeconds() / 3600;
  const ha = Math.PI / 2 - (hrs / 24) * TAU;
  const hp1 = project([WHEEL.x, WHEEL.y, WHEEL.z + 0.5], B);
  const hp2 = project([WHEEL.x + Math.cos(ha) * 3.0, WHEEL.y + Math.sin(ha) * 3.0, WHEEL.z + 0.5], B);
  if (hp1 && hp2) {
    ctx.strokeStyle = `rgba(235,240,255,${0.9 * dim})`; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(hp1[0], hp1[1]); ctx.lineTo(hp2[0], hp2[1]); ctx.stroke();
  }
  // readout
  const tstr = info.now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dstr = info.now.toLocaleDateString([], { month: "short", day: "numeric" });
  const pct = Math.round(Math.sin(info.phase * Math.PI) * 100);
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.font = "600 13px Georgia, serif";
  ctx.fillStyle = `rgba(242,224,165,${0.95 * dim})`;
  const rx = VX + 14, ry = VY + 12;
  ctx.fillText(`✦ ${tstr} · ${dstr}`, rx, ry);
  ctx.font = "11px Georgia, serif";
  ctx.fillStyle = `rgba(200,210,225,${0.85 * dim})`;
  ctx.fillText(`Sun in ${info.sign} · Moon ${pct}% lit`, rx, ry + 20);
}

/* ============================== seeds (2D sprites) ============================== */
// seeds live logically in pits; drawn as glowing discs at projected positions.
function seedLayout(n, cx, cz, rMax) {
  // phyllotaxis
  const pts = [];
  const count = Math.min(n, 12);
  for (let i = 0; i < count; i++) {
    const r = rMax * Math.sqrt((i + 0.5) / count) * 0.92;
    const a = i * 2.39996;
    pts.push([cx + Math.cos(a) * r, 0.12 + (i % 3) * 0.07, cz + Math.sin(a) * r]);
  }
  return pts;
}
function drawSeeds(B, flying) {
  const dim = 1 - eclipseDim * 0.5;
  for (let i = 0; i < 14; i++) {
    const n = G.state.pits[i];
    if (!n) continue;
    const [cx, , cz] = pitPos(i);
    const rMax = (i === 6 || i === 13) ? 0.72 : 0.5;
    for (const [x, y, z] of seedLayout(n, cx, cz, rMax)) {
      const p = project([x, y, z], B);
      if (!p) continue;
      const pr = clamp(900 / p[2] * 0.09, 3, 14);
      const gr = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], pr * 2.2);
      gr.addColorStop(0, `rgba(255,200,120,${0.9 * dim})`);
      gr.addColorStop(0.4, `rgba(255,179,71,${0.55 * dim})`);
      gr.addColorStop(1, "rgba(255,179,71,0)");
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.arc(p[0], p[1], pr * 2.2, 0, TAU); ctx.fill();
      ctx.fillStyle = `rgb(255,${170 * dim | 0},80)`;
      ctx.beginPath(); ctx.arc(p[0], p[1], pr, 0, TAU); ctx.fill();
    }
    // count label
    const lp = project([cx, 0.32, cz + ((i === 6 || i === 13) ? 0 : (i < 6 ? 0.95 : -0.95))], B);
    if (lp && n > 0) {
      ctx.font = "600 13px Georgia, serif"; ctx.textAlign = "center";
      ctx.fillStyle = `rgba(232,220,192,${0.92 * dim})`;
      ctx.fillText(String(n), lp[0], lp[1]);
    }
  }
  // flying seeds
  for (const f of flying) {
    const p = project(f.pos, B);
    if (!p) continue;
    const pr = clamp(900 / p[2] * 0.11, 4, 16);
    ctx.fillStyle = "#ffd9a0";
    ctx.beginPath(); ctx.arc(p[0], p[1], pr, 0, TAU); ctx.fill();
  }
}

/* ============================== tweens ============================== */
const tweens = [];
function tween(dur, onU, onC) {
  return new Promise((res) => tweens.push({ t: 0, dur, onU, onC: () => { onC && onC(); res(); } }));
}
function stepTweens(dt) {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i];
    tw.t += dt;
    const k = clamp(tw.t / tw.dur, 0, 1);
    tw.onU(k);
    if (k >= 1) { tweens.splice(i, 1); tw.onC(); }
  }
}
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/* ============================== time events ============================== */
function addGrains(n) {
  G.grains += n;
  // every grain clicks the main wheel forward two teeth (48 teeth, 24/moon)
  // the wheel TURNS: 3 teeth per grain — the moon advances one full
  // revolution every 16 grains (a dramatic, visible step each sowing)
  G.gearMainTarget += n * (TAU / 48) * 3;
  G.clockKick = Math.min(1, G.clockKick + n * 0.35); // jolt the machine
  Audio2.gear();
  while (G.grains >= G.MOON_LEN) {
    G.grains -= G.MOON_LEN;
    G.moons++;
    G.moon++;
    onNewMoon();
  }
  updateHud();
}

function onNewMoon() {
  // saros dial: full turn every 3 moons -> great eclipse
  G.saros = (G.moons % 3) / 3;
  if (G.moons % 3 === 0) {
    greatEclipse();
    return;
  }
  if (G.moons % 12 === 0) { olympiad(); return; }
  const omen = G.omens[G.omenIdx % G.omens.length];
  G.omenIdx++;
  applyOmen(omen, G.state.turn);
}

function applyOmen(omen, side) {
  const you = side === 0;
  showOmen(omen);
  Audio2.gong();
  if (omen === "eclipse") {
    G.eclipseArmed = true;
    setBanner("Eclipse omen — the next capture is doubled.");
  } else if (omen === "bloom") {
    const [a, b] = side === 0 ? [0, 5] : [7, 12];
    for (let i = a; i <= b; i++) G.state.pits[i]++;
    setBanner(you ? "Bloom — a grain appears in each of your houses." : "Bloom — the Automaton's houses swell.");
  } else if (omen === "harvest") {
    G.state.pits[side === 0 ? 6 : 13] += 2;
    setBanner(you ? "Harvest — +2 grains to your granary." : "Harvest — the Automaton reaps +2.");
  } else if (omen === "oracle") {
    setBanner("The Oracle grants " + (you ? "you" : "the Automaton") + " another turn.");
    G.oracleTurn = side;
  }
  updateHud();
}

function greatEclipse() {
  showOmen("great");
  Audio2.eclipse();
  G.eclipseRounds = 2; // both players' next full rounds
  tween(2.2, (k) => { eclipseDim = Math.sin(k * Math.PI); });
  setBanner("GREAT ECLIPSE — all captures doubled while shadow lasts.");
}

function olympiad() {
  showOmen("olympiad");
  Audio2.win();
  for (let i = 0; i < 14; i++) {
    if (i === 6 || i === 13) continue;
    G.state.pits[i]++;
  }
  setBanner("OLYMPIAD — the wheel turns four years; every house gains a grain.");
  updateHud();
}

/* ============================== move animation ============================== */
const flying = []; // {pos:[x,y,z]}
async function animateSow(r, moverName) {
  // r.sowed: pit indices in order. One grain hops per step.
  const stepDur = REDUCED ? 0.03 : 0.16;
  for (let s = 0; s < r.sowed.length; s++) {
    const target = r.sowed[s];
    // find a source: previous pit (or the played pit for s=0)
    const [tx, , tz] = pitPos(target);
    const f = { pos: [tx + (Math.random() - 0.5), 1.6, tz + (Math.random() - 0.5)] };
    flying.push(f);
    const sx = f.pos[0], sz = f.pos[2];
    Audio2.tick(target);
    addGrains(1);
    await tween(stepDur, (k) => {
      const e = easeOut(k);
      f.pos[0] = lerp(sx, tx, e);
      f.pos[2] = lerp(sz, tz, e);
      f.pos[1] = lerp(1.6, 0.2, e) + Math.sin(k * Math.PI) * 0.9;
    });
    flying.splice(flying.indexOf(f), 1);
  }
  if (r.captured > 0) {
    Audio2.capture();
    setBanner(`${moverName} captures ${r.captured} grains!`);
    await tween(REDUCED ? 0.05 : 0.5, () => {});
  }
  if (G.eclipseArmed) G.eclipseArmed = false;
}

// If a capture lands under an eclipse omen, double it: the capture already
// moved `captured` grains to the mover's store, so add that many again.
function applyEclipseDoubling(r) {
  if (r.captured <= 0) return r;
  if (!(G.eclipseArmed || G.eclipseRounds > 0)) return r;
  const store = G.lastMover === 0 ? 6 : 13;
  r.state.pits[store] += r.captured;
  r.captured *= 2;
  return r;
}

/* ============================== turns ============================== */
async function playerMove(pit) {
  if (G.animating || !G.started || G.state.over) return;
  if (G.state.turn !== 0) return;
  if (!legalMoves(G.state).includes(pit)) return;
  G.animating = true;
  Audio2.init();
  setBanner("Sowing…");
  G.lastMover = 0;
  let r = applyMove(G.state, pit);
  r = applyEclipseDoubling(r);
  await animateSow(r, "You");
  G.state = r.state;
  if (G.eclipseRounds > 0) G.eclipseRounds--;
  updateHud();
  if (r.gameOver) return endGame();
  if (G.oracleTurn === 0) { G.oracleTurn = -1; setBanner("Oracle's gift — sow again."); }
  else if (!r.extraTurn) { G.state.turn = 1; }
  else setBanner("Your last grain found the granary — sow again!");
  G.animating = false;
  updateHud();
  if (G.state.turn === 1 && !G.state.over) setTimeout(aiTurn, REDUCED ? 100 : 650);
  else if (!G.state.over) setBanner("Your move — sow a house.");
}

async function aiTurn() {
  if (G.state.over || G.animating) return;
  G.animating = true;
  setBanner("The Automaton ponders the gears…");
  await tween(REDUCED ? 0.05 : 0.45, () => {});
  const pit = chooseAiMove(G.state, 4);
  G.lastMover = 1;
  let r = applyMove(G.state, pit);
  r = applyEclipseDoubling(r);
  await animateSow(r, "The Automaton");
  G.state = r.state;
  if (G.eclipseRounds > 0) G.eclipseRounds--;
  updateHud();
  if (r.gameOver) return endGame();
  if (G.oracleTurn === 1) { G.oracleTurn = -1; setBanner("Oracle's gift — the Automaton sows again."); }
  else if (!r.extraTurn) { G.state.turn = 0; }
  G.animating = false;
  updateHud();
  if (G.state.turn === 1 && !G.state.over) setTimeout(aiTurn, REDUCED ? 100 : 650);
  else if (!G.state.over) setBanner("Your move — sow a house.");
}

function endGame() {
  G.animating = false;
  updateHud();
  const [a, b] = scores(G.state);
  const w = winner(G.state);
  const t = document.getElementById("end-title");
  const d = document.getElementById("end-detail");
  if (w === 0) { t.textContent = "THE STARS FAVOR YOU"; Audio2.win(); }
  else if (w === 1) { t.textContent = "THE AUTOMATON PREVAILS"; Audio2.lose(); }
  else { t.textContent = "A PERFECT BALANCE"; Audio2.gong(); }
  d.textContent = `you ${a} — automaton ${b} · ${G.moons} moons turned`;
  setTimeout(() => document.getElementById("end-screen").classList.remove("hidden"), 900);
}

function resetMatch() {
  G.state = newMancala();
  G.grains = 0; G.moon = 1; G.moons = 0; G.omenIdx = 0;
  G.eclipseArmed = false; G.eclipseRounds = 0; G.oracleTurn = -1;
  G.gearMain = 0; G.gearMainTarget = 0; G.gearVel = 0; G.clockKick = 0; G.saros = 0;
  G.animating = false;
  document.getElementById("end-screen").classList.add("hidden");
  setBanner("Sow a house to begin.");
  updateHud();
}

/* ============================== input (3D picking) ============================== */
function screenToPit(cx, cy) {
  // picking happens in the board viewport (bottom half)
  const L = layout();
  setCam(camBoardDef);
  VX = L.board.x; VY = L.board.y; VW = L.board.w; VH = L.board.h;
  const B = camBasis();
  // ray: origin cam.pos, dir through pixel (viewport-relative)
  const nx = (cx - (VX + VW / 2)) / cam.f, ny = -((cy - (VY + VH / 2))) / cam.f;
  const dir = norm3([
    B.right[0] * nx + B.up[0] * ny + B.fwd[0],
    B.right[1] * nx + B.up[1] * ny + B.fwd[1],
    B.right[2] * nx + B.up[2] * ny + B.fwd[2],
  ]);
  if (Math.abs(dir[1]) < 1e-6) return -1;
  const t = -cam.pos[1] / dir[1];
  if (t < 0) return -1;
  const px = cam.pos[0] + dir[0] * t, pz = cam.pos[2] + dir[2] * t;
  let best = -1, bd = 0.85;
  for (let i = 0; i < 6; i++) {
    const [x, , z] = pitPos(i);
    const d = Math.hypot(px - x, pz - z);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
canvas.addEventListener("pointerdown", (e) => {
  Audio2.init();
  if (G.celestial) return; // exploration mode: no moves
  if (!G.started || G.animating || G.state.turn !== 0) return;
  const pit = screenToPit(e.clientX, e.clientY);
  if (pit >= 0) playerMove(pit);
});
// hover highlight
let hoverPit = -1;
canvas.addEventListener("pointermove", (e) => {
  if (G.state && G.state.turn === 0 && !G.animating) hoverPit = screenToPit(e.clientX, e.clientY);
  else hoverPit = -1;
});

/* ============================== main loop ============================== */
let lastT = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0.016);
  lastT = t;
  stepTweens(dt);
  // gears: underdamped spring toward target — a mechanical CLUNK with overshoot
  const prev = G.gearMain;
  const stiff = 140, damp = 9;
  G.gearVel += ((G.gearMainTarget - G.gearMain) * stiff - G.gearVel * damp) * dt;
  G.gearMain += G.gearVel * dt;
  const dMain = G.gearMain - prev;
  // clock kick decays; jolts the clock camera for drama
  G.clockKick = Math.max(0, G.clockKick - dt * 2.2);
  // the clockwork: every wheel spins in its own plane (rz), meshed by ratio.
  // One input — the sowing — drives the main wheel; the train follows.
  // In celestial mode the sun/moon hands read the real sky.
  const cel = G.celestial ? nowInfo() : null;
  for (const g of gears) {
    if (g.kind === "main") g.inst.rz = G.gearMain;
    else if (g.kind === "spoke") g.inst.rz = G.gearMain + g.off - Math.PI / 2;
    else if (g.kind === "sat") g.inst.rz = G.gearMain * g.ratio + g.phase;
    else if (g.kind === "moonHand") g.inst.rz = (cel ? cel.moonLon * Math.PI / 180 : lunarAngle()) - Math.PI / 2;
    else if (g.kind === "sunHand") g.inst.rz = (cel ? cel.sunLon * Math.PI / 180 : sunAngle()) - Math.PI / 2;
    else if (g.kind === "saros") g.inst.rz = G.saros * TAU - Math.PI / 2;
    else if (g.kind === "sarosEye") {
      const sa = G.saros * TAU;
      g.inst.pos = [WHEEL.x + Math.cos(sa) * 2.2, WHEEL.y + Math.sin(sa) * 2.2, WHEEL.z + 0.62];
    }
  }
  // idle drift so the machine feels alive
  if (!G.started || (!G.animating && G.grains === 0)) {
    G.gearMainTarget += dt * 0.05;
  }
  const L = layout();
  drawBackground();
  // --- top half: the clock, large and dramatic ---
  {
    const kick = G.clockKick * G.clockKick;
    setCam(camClockDef);
    if (!REDUCED && kick > 0.001) {
      cam.pos[0] += (Math.random() - 0.5) * 0.35 * kick;
      cam.pos[1] += (Math.random() - 0.5) * 0.35 * kick;
    }
    VX = L.clock.x; VY = L.clock.y; VW = L.clock.w; VH = L.clock.h;
    const B = camBasis();
    ctx.save();
    ctx.beginPath(); ctx.rect(VX, VY, VW, VH); ctx.clip();
    renderScene(instances, B, "clock");
    drawZodiac(B);
    if (cel) drawCelestialClock(B, cel);
    ctx.restore();
    // divider
    ctx.strokeStyle = "rgba(216,164,116,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, L.clock.h); ctx.lineTo(W, L.clock.h); ctx.stroke();
  }
  // --- bottom half: the board ---
  {
    setCam(camBoardDef);
    if (!REDUCED) {
      cam.sway += dt;
      cam.pos[0] = Math.sin(cam.sway * 0.11) * 0.4;
    }
    VX = L.board.x; VY = L.board.y; VW = L.board.w; VH = L.board.h;
    const B = camBasis();
    ctx.save();
    ctx.beginPath(); ctx.rect(VX, VY, VW, VH); ctx.clip();
    if (G.celestial && cel) {
      drawStarChart(cel);
    } else {
      renderScene(instances, B, "board");
      drawSeeds(B, flying);
    }
    // hover ring highlight
    if (!G.celestial && hoverPit >= 0 && legalMoves(G.state).includes(hoverPit)) {
      const [x, , z] = pitPos(hoverPit);
      const p = project([x, 0.05, z], B);
      if (p) {
        ctx.strokeStyle = "rgba(67,179,162,0.9)"; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(p[0], p[1], 30, 0, TAU); ctx.stroke();
      }
    }
    ctx.restore();
  }
  void dMain;
}

/* ============================== ui wiring ============================== */
document.getElementById("btn-begin").addEventListener("click", () => {
  Audio2.init();
  document.getElementById("title-screen").classList.add("hidden");
  G.started = true;
  Audio2.gong();
  setBanner("Your move — sow a house.");
});
document.getElementById("btn-again").addEventListener("click", () => { resetMatch(); });
document.getElementById("btn-new").addEventListener("click", () => { resetMatch(); });
document.getElementById("btn-sound").addEventListener("click", (e) => {
  Audio2.init();
  const off = Audio2.toggle();
  e.currentTarget.classList.toggle("off", off);
  e.currentTarget.textContent = off ? "✕" : "♪";
});
document.getElementById("btn-celestial").addEventListener("click", (e) => {
  Audio2.init();
  G.celestial = !G.celestial;
  e.currentTarget.style.color = G.celestial ? "#f2e0a5" : "";
  setBanner(G.celestial ? "Celestial exploration — the clock reads the real sky." : "Back to the game.");
  if (G.celestial) Audio2.gong(); else Audio2.tick();
});

/* ============================== boot ============================== */
buildBoard();
buildMechanism();
resetMatch();
G.started = false;
requestAnimationFrame(frame);
