import { createGame, playMove } from './tree.js';

const PROGRESS_KEY = 'repertoire-progress';
const LEARNED_STREAK = 2; // clean runs in a row before a sequence counts as learned

function readProgress() {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY)) ?? {};
  } catch {
    return {};
  }
}

const progress = readProgress();

function saveProgress() {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Progress simply won't persist in this browser.
  }
}

const sequenceKey = (repertoire, moves) => `${repertoire.id}:${moves.join(' ')}`;

export function learnedCount(repertoire, line) {
  return line.sequences.filter((moves) => (progress[sequenceKey(repertoire, moves)]?.streak ?? 0) >= LEARNED_STREAK).length;
}

export function recordRun(repertoire, moves, clean) {
  const key = sequenceKey(repertoire, moves);
  progress[key] = { streak: clean ? (progress[key]?.streak ?? 0) + 1 : 0, seen: Date.now() };
  saveProgress();
}

// Weakest sequence first, then the one seen longest ago, skipping the run just finished.
export function pickSequence(repertoire, lines, previous) {
  const entries = lines.flatMap((line) => line.sequences.map((moves) => ({ line, moves })));
  const candidates = entries.length > 1 ? entries.filter((e) => e.moves !== previous) : entries;
  const rank = (entry) => progress[sequenceKey(repertoire, entry.moves)] ?? { streak: 0, seen: 0 };
  const ordered = candidates
    .map((entry) => ({ entry, order: Math.random() }))
    .sort((a, b) => {
      const ra = rank(a.entry);
      const rb = rank(b.entry);
      return ra.streak - rb.streak || ra.seen - rb.seen || a.order - b.order;
    });
  return ordered[0].entry;
}

// A line as a game, with its branches as variations. Returns the game and the repertoire move.
export function lineToGame(line) {
  const game = createGame();
  let key = game.root;
  line.sequences.forEach((moves) => {
    let node = game.root;
    moves.forEach((san, ply) => {
      node = playMove(node, san);
      if (ply === line.keyPly - 1) key = node;
    });
  });
  return { game, key };
}
