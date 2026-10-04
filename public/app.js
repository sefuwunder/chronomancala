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
const cam = { pos: [0, 8, 12.5], look: [0, 0.2, 0], f: 700, sway: 0 };
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

// project world -> screen. Returns null behind camera.
function project(p, B) {
  const d = sub3(p, cam.pos);
  const z = dot3(d, B.fwd), x = dot3(d, B.right), y = dot3(d, B.up);
  if (z < 0.5) return null;
  let sx = W / 2 + (x / z) * cam.f;
  let sy = H / 2 - (y / z) * cam.f;
  if (!REDUCED) { sx = Math.round(sx) + 0.0; sy = Math.round(sy); } // PS1 snap
  return [sx, sy, z];
}

// rotate point around Y then X (object space)
function rotYX(p, ry, rx) {
  let [x, y, z] = p;
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

// instances: { mesh, pos:[x,y,z], ry, rx, tint:[r,g,b]|null }
function renderScene(instances, B) {
  // background gradient + stars (2D)
  const g = ctx.createLinearGradient(0, 0, 0, H);
  const dim = 1 - eclipseDim * 0.75;
  g.addColorStop(0, `rgb(${11 * dim | 0},${14 * dim | 0},${26 * dim | 0})`);
  g.addColorStop(0.6, `rgb(${7 * dim | 0},${8 * dim | 0},${18 * dim | 0})`);
  g.addColorStop(1, `rgb(${5 * dim | 0},${6 * dim | 0},${13 * dim | 0})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  drawStars(dim);

  const tris = [];
  for (const inst of instances) {
    const { mesh, pos } = inst;
    const wv = new Array(mesh.v.length);
    for (let i = 0; i < mesh.v.length; i++) {
      const r = rotYX(mesh.v[i], inst.ry || 0, inst.rx || 0);
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
  gearMain: 0, gearMainTarget: 0,
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
function addInst(mesh, pos, opts = {}) {
  const inst = { mesh, pos, ry: opts.ry || 0, rx: opts.rx || 0, tint: opts.tint || null };
  instances.push(inst); return inst;
}

function buildBoard() {
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
}

// --- the mechanism: gear train behind the board ---
const gears = [];
const WHEEL = { x: 0, y: 5.1, z: -8.8, pitch: 2.78 };
function buildMechanism() {
  // main lunar wheel: big, vertical, behind board
  const main = gearMesh(48, 3.0, 2.55, 0.5, BRONZE, 0.6);
  const g0 = addInst(main, [WHEEL.x, WHEEL.y, WHEEL.z], { rx: -0.1 });
  gears.push({ inst: g0, ratio: 1, phase: 0, kind: "main" });
  // satellite gears meshing around it (pitch radii sum = center distance)
  const sats = [
    { t: 16, ang: 200 * Math.PI / 180 },
    { t: 12, ang: -20 * Math.PI / 180 },
    { t: 20, ang: 70 * Math.PI / 180 },
  ];
  for (const s of sats) {
    const r = WHEEL.pitch * (s.t / 48);
    const d = WHEEL.pitch + r;
    const g = gearMesh(s.t, r * 1.08, r * 0.92, 0.4, s.t === 12 ? VERDI : BRONZE_DK, r * 0.32);
    const inst = addInst(g, [WHEEL.x + Math.cos(s.ang) * d, WHEEL.y + Math.sin(s.ang) * d, WHEEL.z], { rx: -0.1 });
    gears.push({ inst, ratio: -48 / s.t, phase: Math.PI / s.t, kind: "sat" });
  }
  // saros pointer arm on the main wheel
  const arm = boxMesh(0.1, 2.0, 0.08, VERDI);
  const pointer = addInst(arm, [WHEEL.x, WHEEL.y, WHEEL.z + 0.35], {});
  gears.push({ inst: pointer, kind: "saros" });
  const eye = cylMesh(0.28, 0.16, 16, [20, 22, 34]);
  const eyeI = addInst(eye, [0, 0, 0], { rx: Math.PI / 2 });
  gears.push({ inst: eyeI, kind: "sarosEye" });
  // (the wheel floats; no pedestal — it is a dream of bronze)
}

// zodiac glyphs projected onto the main wheel (2D overlay)
const ZODIAC = ["Α", "Β", "Γ", "Δ", "Ε", "Ζ", "Η", "Θ", "Ι", "Κ", "Λ", "Μ"];
function drawZodiac(B) {
  const g = gears[0]; if (!g) return;
  ctx.font = "12px Georgia, serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  const dim = 1 - eclipseDim * 0.6;
  for (let i = 0; i < 12; i++) {
    const a = G.gearMain + (i / 12) * TAU;
    const x = Math.cos(a) * 2.62, y = Math.sin(a) * 2.62;
    const wp = rotYX([x, y, 0.28], 0, -0.1);
    const p = project([wp[0] + WHEEL.x, wp[1] + WHEEL.y, wp[2] + WHEEL.z], B);
    if (!p) continue;
    ctx.fillStyle = `rgba(232,220,192,${0.7 * dim})`;
    ctx.fillText(ZODIAC[i], p[0], p[1]);
  }
  // eclipse marker at saros angle
  const sa = G.saros * TAU;
  const ex = Math.cos(sa) * 1.7, ey = Math.sin(sa) * 1.7;
  const ep = rotYX([ex, ey, 0.32], 0, -0.1);
  const sp = project([ep[0] + WHEEL.x, ep[1] + WHEEL.y, ep[2] + WHEEL.z], B);
  if (sp) {
    ctx.fillStyle = `rgba(20,20,30,${0.95})`;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], 7, 0, TAU); ctx.fill();
    ctx.strokeStyle = `rgba(255,179,71,${0.9 * dim})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sp[0], sp[1], 9, 0, TAU); ctx.stroke();
  }
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
  G.gearMainTarget += n * (TAU / 48) * 2;
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
  G.gearMain = 0; G.gearMainTarget = 0; G.saros = 0;
  G.animating = false;
  document.getElementById("end-screen").classList.add("hidden");
  setBanner("Sow a house to begin.");
  updateHud();
}

/* ============================== input (3D picking) ============================== */
function screenToPit(cx, cy) {
  const B = camBasis();
  // ray: origin cam.pos, dir through pixel
  const nx = (cx - W / 2) / cam.f, ny = -(cy - H / 2) / cam.f;
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
  // camera sway
  if (!REDUCED) {
    cam.sway += dt;
    cam.pos[0] = Math.sin(cam.sway * 0.11) * 0.5;
    cam.pos[1] = 8 + Math.sin(cam.sway * 0.07) * 0.25;
  }
  const B = camBasis();
  // gears: spring toward target
  const prev = G.gearMain;
  G.gearMain += (G.gearMainTarget - G.gearMain) * Math.min(1, dt * 7);
  const dMain = G.gearMain - prev;
  for (const g of gears) {
    if (g.kind === "main") g.inst.ry = -G.gearMain;
    else if (g.kind === "sat") g.inst.ry = -G.gearMain * g.ratio + g.phase;
    else if (g.kind === "saros") {
      g.inst.ry = G.saros * TAU;
      g.inst.pos = [WHEEL.x, WHEEL.y, WHEEL.z + 0.35];
    } else if (g.kind === "sarosEye") {
      const sa = G.saros * TAU;
      g.inst.pos = [WHEEL.x + Math.cos(sa) * 1.7, WHEEL.y + Math.sin(sa) * 1.7, WHEEL.z + 0.4];
    }
  }
  // idle drift so the machine feels alive
  if (!G.started || (!G.animating && G.grains === 0)) {
    G.gearMainTarget += dt * 0.05;
  }
  renderScene(instances, B);
  drawZodiac(B);
  drawSeeds(B, flying);
  // hover ring highlight
  if (hoverPit >= 0 && legalMoves(G.state).includes(hoverPit)) {
    const [x, , z] = pitPos(hoverPit);
    const p = project([x, 0.05, z], B);
    if (p) {
      ctx.strokeStyle = "rgba(67,179,162,0.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p[0], p[1], 30, 0, TAU); ctx.stroke();
    }
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

/* ============================== boot ============================== */
buildBoard();
buildMechanism();
resetMatch();
G.started = false;
requestAnimationFrame(frame);
