// game.js — pure Mancala (Kalah 6x4) rules + Automaton AI. No DOM, no audio.
// Pits: 0-5 yours, 6 your granary, 7-12 automaton's, 13 its granary.
// Sowing runs counter-clockwise; you skip 13, the automaton skips 6.
export const PITS = 6;
export const SEEDS = 4;
export const YOU = 0;
export const FOE = 1;

export function newGame() {
  const pits = new Array(14).fill(0);
  for (let i = 0; i < 6; i++) { pits[i] = SEEDS; pits[7 + i] = SEEDS; }
  return { pits, turn: YOU, over: false };
}

export function clone(s) {
  return { pits: s.pits.slice(), turn: s.turn, over: s.over };
}

const STORE = [6, 13];
const ownRange = (side) => (side === YOU ? [0, 5] : [7, 12]);
// sowing order for a side: own pits, own store, foe pits (skip foe store)
function order(side) {
  if (side === YOU) return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  return [7, 8, 9, 10, 11, 12, 13, 0, 1, 2, 3, 4, 5];
}
const opposite = (pit) => 12 - pit; // 0<->12 … 5<->7

export function legalMoves(s) {
  const [a, b] = ownRange(s.turn);
  const out = [];
  for (let i = a; i <= b; i++) if (s.pits[i] > 0) out.push(i);
  return out;
}

function sideEmpty(pits, side) {
  const [a, b] = ownRange(side);
  for (let i = a; i <= b; i++) if (pits[i] > 0) return false;
  return true;
}

// Sweep remaining seeds into each side's granary at game end.
export function collect(pits) {
  const p = pits.slice();
  for (const side of [YOU, FOE]) {
    const [a, b] = ownRange(side);
    let rest = 0;
    for (let i = a; i <= b; i++) { rest += p[i]; p[i] = 0; }
    p[STORE[side]] += rest;
  }
  return p;
}

export function isOver(s) {
  return s.over || sideEmpty(s.pits, YOU) || sideEmpty(s.pits, FOE);
}

export function winner(s) {
  const p = s.over ? s.pits : collect(s.pits);
  if (p[6] > p[13]) return YOU;
  if (p[13] > p[6]) return FOE;
  return -1; // draw
}

export function scores(s) {
  const p = s.over ? s.pits : collect(s.pits);
  return [p[6], p[13]];
}

// Apply a move. Returns { state, sowed:[pitIdx...], extraTurn, captured, gameOver }.
// sowed lists every pit that received a seed, in order (drives the gears).
export function applyMove(s, pit) {
  const st = clone(s);
  const me = st.turn;
  const ord = order(me);
  let seeds = st.pits[pit];
  if (seeds <= 0) throw new Error("empty house");
  st.pits[pit] = 0;
  let idx = ord.indexOf(pit);
  const sowed = [];
  while (seeds > 0) {
    idx = (idx + 1) % ord.length;
    const p = ord[idx];
    st.pits[p]++;
    sowed.push(p);
    seeds--;
  }
  const last = ord[idx];
  let extraTurn = false;
  let captured = 0;
  const [a, b] = ownRange(me);
  if (last === STORE[me]) {
    extraTurn = true; // last grain falls in your granary: sow again
  } else if (last >= a && last <= b && st.pits[last] === 1) {
    // last grain lands in an empty house of yours: capture the opposite
    const opp = opposite(last);
    captured = st.pits[opp] + 1;
    if (st.pits[opp] > 0) {
      st.pits[STORE[me]] += captured;
      st.pits[opp] = 0;
      st.pits[last] = 0;
    } else {
      captured = 0;
    }
  }
  let gameOver = false;
  if (sideEmpty(st.pits, YOU) || sideEmpty(st.pits, FOE)) {
    st.pits = collect(st.pits);
    st.over = true;
    gameOver = true;
  } else {
    st.turn = extraTurn ? me : 1 - me;
  }
  return { state: st, sowed, extraTurn, captured, gameOver };
}

// ---------- Automaton (minimax, alpha-beta) ----------

function evalFor(pits, me) {
  const foe = 1 - me;
  let myPits = 0, foePits = 0;
  for (let i = 0; i < 6; i++) { myPits += pits[me === YOU ? i : 7 + i]; foePits += pits[foe === YOU ? i : 7 + i]; }
  return (pits[STORE[me]] - pits[STORE[foe]]) * 12 + (myPits - foePits);
}

function minimax(st, depth, alpha, beta, me) {
  if (depth <= 0 || st.over || sideEmpty(st.pits, YOU) || sideEmpty(st.pits, FOE)) {
    const p = st.over ? st.pits : collect(st.pits);
    const diff = p[STORE[me]] - p[STORE[1 - me]];
    if (st.over || depth <= 0) return diff * 12 + evalFor(p, me) * 0.2 + (Math.random() * 0.6 - 0.3);
    return diff * 1000;
  }
  const maximizing = st.turn === me;
  let best = maximizing ? -Infinity : Infinity;
  for (const m of legalMoves(st)) {
    const r = applyMove(st, m);
    // extra turn: same side moves again, don't deepen (bounded in practice)
    const v = minimax(r.state, r.extraTurn ? depth : depth - 1, alpha, beta, me);
    if (maximizing) { best = Math.max(best, v); alpha = Math.max(alpha, v); }
    else { best = Math.min(best, v); beta = Math.min(beta, v); }
    if (beta <= alpha) break;
  }
  return best;
}

export function chooseAiMove(s, depth = 4) {
  let best = -Infinity, bestPit = legalMoves(s)[0];
  for (const m of legalMoves(s)) {
    const r = applyMove(s, m);
    const v = minimax(r.state, r.extraTurn ? depth : depth - 1, -Infinity, Infinity, s.turn);
    if (v > best + 1e-9) { best = v; bestPit = m; }
  }
  return bestPit;
}
