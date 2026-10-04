// game.test.js — Kalah rules + AI sanity. Run: bun test tests/
import { describe, test, expect } from "bun:test";
import { newGame, legalMoves, applyMove, isOver, winner, scores, chooseAiMove, YOU, FOE } from "../public/game.js";

describe("rules", () => {
  test("fresh board: 4 per house, empty granaries", () => {
    const s = newGame();
    expect(s.pits.slice(0, 6)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(s.pits.slice(7, 13)).toEqual([4, 4, 4, 4, 4, 4]);
    expect(s.pits[6]).toBe(0); expect(s.pits[13]).toBe(0);
  });
  test("sowing moves one grain per house", () => {
    const s = newGame();
    const r = applyMove(s, 2);
    expect(r.sowed).toEqual([3, 4, 5, 6]);
    expect(r.state.pits[2]).toBe(0);
    expect(r.state.pits[6]).toBe(1);
    expect(r.extraTurn).toBe(true); // landed in granary
  });
  test("capture: last grain in empty own house takes the opposite", () => {
    const s = newGame();
    s.pits = [0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0];
    s.turn = YOU;
    const r = applyMove(s, 2); // sows to pit 3 (empty) opposite pit 9 (5)
    expect(r.captured).toBe(6);
    expect(r.state.pits[6]).toBe(6);
    expect(r.state.pits[9]).toBe(0);
    expect(r.state.pits[3]).toBe(0);
  });
  test("no capture when opposite is empty", () => {
    const s = newGame();
    s.pits = [0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1, 1, 0];
    s.turn = YOU;
    const r = applyMove(s, 2);
    expect(r.captured).toBe(0);
    expect(r.state.pits[3]).toBe(1);
  });
  test("sowing wraps past the foe granary without touching it", () => {
    const s = newGame();
    s.pits = [1, 0, 0, 0, 0, 8, 0, 2, 2, 2, 2, 2, 2, 0];
    s.turn = YOU;
    const r = applyMove(s, 5);
    expect(r.state.pits[13]).toBe(0);
    expect(r.sowed.length).toBe(8);
    expect(r.sowed).toEqual([6, 7, 8, 9, 10, 11, 12, 0]);
  });
  test("game ends when a side empties; remainder swept", () => {
    const s = newGame();
    s.pits = [0, 0, 0, 0, 0, 1, 10, 3, 3, 3, 3, 3, 3, 20];
    s.turn = YOU;
    const r = applyMove(s, 5);
    expect(r.gameOver).toBe(true);
    expect(r.state.over).toBe(true);
    const [a, b] = scores(r.state);
    expect(a).toBe(11); expect(b).toBe(38);
    expect(winner(r.state)).toBe(FOE);
  });
  test("legalMoves only lists non-empty own houses", () => {
    const s = newGame(); s.turn = FOE;
    s.pits[7] = 0; s.pits[9] = 0;
    expect(legalMoves(s)).toEqual([8, 10, 11, 12]);
  });
});

describe("automaton", () => {
  test("takes an obvious capture", () => {
    const s = newGame(); s.turn = FOE;
    // foe pit 7 has 1 -> lands in 8 (empty), opposite pit 4 has 5
    s.pits = [0, 0, 0, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    expect(chooseAiMove(s, 3)).toBe(7);
  });
  test("takes the extra turn when it wins material", () => {
    const s = newGame(); s.turn = FOE;
    s.pits = [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 6, 0];
    const m = chooseAiMove(s, 3);
    expect([7, 8, 9, 10, 11, 12]).toContain(m);
  });
  test("never plays an empty house and finishes games", () => {
    let s = newGame();
    let guard = 0;
    while (!isOver(s) && guard++ < 300) {
      const moves = legalMoves(s);
      expect(moves.length).toBeGreaterThan(0);
      const m = s.turn === YOU ? moves[0] : chooseAiMove(s, 3);
      s = applyMove(s, m).state;
    }
    expect(isOver(s)).toBe(true);
    expect([-1, 0, 1]).toContain(winner(s));
  });
});
