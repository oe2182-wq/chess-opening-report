// How the computer plays at a chosen rating. Pure functions, shared by the browser (src/bot.js)
// and the calibration script (tools/calibrate_bot.mjs).
//
// 1320 and up: Stockfish's own strength limit (UCI_Elo, 1320-3190).
// Below 1320: a shallow search scores every legal move, then a move is drawn at random, weighted
// by how much it loses; a higher "temperature" makes costly moves more likely. Temperatures were
// set by playing this mode against Stockfish's 1320 setting (see tools/calibrate_bot.mjs).
// The top of the slider is full strength, with no limit at all.

export const MIN_RATING = 250;
export const MAX_RATING = 3200; // shown as "Max"
export const RATING_STEP = 50;
export const LIMIT_FLOOR = 1320;
export const LIMIT_CEILING = 3190;

// The weak mode's search depth, and the rating each temperature plays at. Measured on 2026-11-07 with
// tools/calibrate_bot.mjs: 6,000 games, 300 per pairing, Stockfish's 1320 setting held at 1320.
// Stockfish's own 1500, 1700 and 2000 settings came out on their nominal ratings in the same fit
// (scale factor 1.01), so these ratings sit on the same scale as the 1320-3190 range above them.
export const PICK_DEPTH = 1;
export const LOW_LEVELS = [
  { rating: 194, temperature: 400 },
  { rating: 431, temperature: 280 },
  { rating: 607, temperature: 200 },
  { rating: 800, temperature: 140 },
  { rating: 1013, temperature: 100 },
  { rating: 1219, temperature: 70 },
  { rating: 1421, temperature: 50 },
];

// Stockfish's own mapping from UCI_Elo to its internal skill level (search.cpp, Skill).
function skillLevel(elo) {
  const e = (elo - LIMIT_FLOOR) / (LIMIT_CEILING - LIMIT_FLOOR);
  return Math.max(0, Math.min(19, ((37.2473 * e - 40.8525) * e + 22.2943) * e - 0.311438));
}

// What to ask the engine for, at a given rating.
export function botPlan(rating) {
  if (rating >= MAX_RATING) return { mode: 'full', movetime: 2500 };
  if (rating >= LIMIT_FLOOR) {
    const elo = Math.min(rating, LIMIT_CEILING);
    // The engine picks its move once it reaches depth 1 + level; searching past that changes nothing.
    const depth = 2 + Math.floor(skillLevel(elo));
    return { mode: 'limit', elo, depth, movetime: 600 + Math.round(2400 * (elo - LIMIT_FLOOR) / (LIMIT_CEILING - LIMIT_FLOOR)) };
  }
  // Between two measured points, the temperature moves evenly on a log scale.
  const levels = LOW_LEVELS;
  const r = Math.max(levels[0].rating, Math.min(levels.at(-1).rating, rating));
  const i = Math.max(1, levels.findIndex((l) => l.rating >= r));
  const a = levels[i - 1];
  const b = levels[i];
  const t = (r - a.rating) / (b.rating - a.rating);
  const temperature = Math.exp(Math.log(a.temperature) + t * (Math.log(b.temperature) - Math.log(a.temperature)));
  return { mode: 'pick', depth: PICK_DEPTH, temperature };
}

// A score from the side to move's point of view, in centipawns, with mates as huge numbers.
export function lineValue({ cp, mate }) {
  if (mate == null) return cp;
  return mate > 0 ? 100000 - mate * 100 : -100000 - mate * 100;
}

// One move's line from a MultiPV search: { index, uci, cp, mate }, or null for lines to skip.
export function parseInfo(line) {
  if (!line.startsWith('info ') || !line.includes(' pv ') || /lowerbound|upperbound/.test(line)) return null;
  const score = line.match(/ score (cp|mate) (-?\d+)/);
  if (!score) return null;
  return {
    index: Number(line.match(/ multipv (\d+)/)?.[1] ?? 1) - 1,
    uci: line.split(' pv ')[1].split(' ')[0],
    cp: score[1] === 'cp' ? Number(score[2]) : null,
    mate: score[1] === 'mate' ? Number(score[2]) : null,
  };
}

const MAX_LOSS = 2000;

// lines: [{ uci, cp, mate }] for every legal move, side-to-move point of view.
export function pickMove(lines, temperature, random = Math.random) {
  const best = Math.max(...lines.map(lineValue));
  const weights = lines.map((l) => Math.exp(-Math.min(MAX_LOSS, best - lineValue(l)) / temperature));
  let x = random() * weights.reduce((sum, w) => sum + w, 0);
  for (let i = 0; i < lines.length; i++) {
    x -= weights[i];
    if (x <= 0) return lines[i].uci;
  }
  return lines.at(-1).uci;
}
