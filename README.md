# CHRONOMANCALA — Seeds of the Antikythera

A cross between **mancala** and a lo-fi retro-3D **Antikythera mechanism**.
You sow grains around the wheel against the Automaton; every grain you sow
clicks the bronze gears forward. Time and resources are the same thing here.

## The blend

- **Sowing winds the clock.** Each grain that falls advances the main lunar
  wheel two teeth. 24 grains = one moon.
- **Moons grant omens.** Every completed moon, the mechanism bestows a
  blessing in rotation: Eclipse (next capture ×2), Bloom (+1 grain per house),
  Harvest (+2 to your granary), Oracle (an extra turn).
- **The Saros dial** turns once every 3 moons — when the eclipse eye aligns,
  a Great Eclipse doubles all captures for a full round and darkens the sky.
- **Olympiad** every 12 moons: every house gains a grain.

## Rules (Kalah)

- 6 houses per side, 4 grains each. Your houses are the near row.
- Lift every grain from one of your houses; they fall one by one
  counter-clockwise, including your granary (right), skipping the foe's.
- Last grain in your granary → sow again.
- Last grain in an empty house of yours → capture it plus the opposite house.
- When one side empties, the rest is swept; most grains wins.

## Run

```sh
bun src/server.ts
# → http://127.0.0.1:3021
```

Zero dependencies. The 3D is a hand-rolled flat-shaded polygon renderer on
canvas 2D (PS1-style vertex snapping), the sound is synthesized WebAudio —
no assets, works offline.

## Tests

```sh
bun test tests/
```
