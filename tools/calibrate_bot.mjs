// Sets the ratings for the computer's weak mode (below 1320) by playing it against Stockfish's own
// 1320 setting, with the same Stockfish 19 Lite build the app runs.
//
//     node tools/calibrate_bot.mjs [games-per-pairing] [engines]
//
// Each weak setting plays its neighbours and the 1320 anchor; ratings are fitted to all results with
// the anchor fixed at 1320. Stockfish's own 1500, 1700 and 2000 settings play too: engines this
// alike exaggerate rating gaps against each other, so the gaps they show (against their nominal
// ratings) give the factor that brings the weak mode's ratings onto Stockfish's nominal scale.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Chess } from '../vendor/chess.js';
import { botPlan, pickMove } from '../src/bot-pick.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SF = join(ROOT, 'vendor/stockfish/stockfish-19-lite-single.js');
const GAMES = Number(process.argv[2] ?? 100);
const ENGINES = Number(process.argv[3] ?? 6);
const MAX_PLIES = 400;

const PLAYERS = {
  sf1320: botPlan(1320),
  sf1500: botPlan(1500),
  sf1700: botPlan(1700),
  sf2000: botPlan(2000),
  ...Object.fromEntries([1000, 600, 400, 280, 200, 140, 100, 70, 50, 35, 25].map((t) => [`t${t}`, { mode: 'pick', depth: 1, temperature: t }])),
};
const ANCHOR = 'sf1320';
const NOMINAL = { sf1320: 1320, sf1500: 1500, sf1700: 1700, sf2000: 2000 };
const PAIRINGS = [
  ['t1000', 't600'], ['t600', 't400'], ['t400', 't280'], ['t280', 't200'], ['t200', 't140'], ['t140', 't100'], ['t100', 't70'], ['t70', 't50'], ['t50', 't35'], ['t35', 't25'],
  ['t140', 'sf1320'], ['t100', 'sf1320'], ['t70', 'sf1320'], ['t50', 'sf1320'], ['t35', 'sf1320'], ['t25', 'sf1320'],
  ['sf1500', 'sf1320'], ['sf1700', 'sf1500'], ['sf1700', 'sf1320'], ['sf2000', 'sf1700'],
];

class Engine {
  constructor() {
    this.proc = spawn(process.execPath, [SF], { cwd: dirname(SF) });
    this.listener = () => {};
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this.listener(line));
  }

  send(cmd) {
    this.proc.stdin.write(`${cmd}\n`);
  }

  until(prefix, onLine = () => {}) {
    return new Promise((resolve) => {
      this.listener = (line) => {
        if (line.startsWith(prefix)) resolve(line);
        else onLine(line);
      };
    });
  }

  async init() {
    const ok = this.until('uciok');
    this.send('uci');
    await ok;
    this.send('setoption name Hash value 16');
    await this.ready();
  }

  async ready() {
    const ok = this.until('readyok');
    this.send('isready');
    await ok;
  }

  async move(plan, moves, legalCount) {
    const position = `position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`;
    if (plan.mode === 'pick') {
      this.send('setoption name UCI_LimitStrength value false');
      this.send(`setoption name MultiPV value ${legalCount}`);
      this.send(position);
      const lines = [];
      const done = this.until('bestmove', (line) => {
        if (!line.startsWith('info ') || !line.includes(' pv ') || /lowerbound|upperbound/.test(line)) return;
        const index = Number(line.match(/ multipv (\d+)/)?.[1] ?? 1) - 1;
        const score = line.match(/ score (cp|mate) (-?\d+)/);
        if (!score) return;
        lines[index] = {
          uci: line.split(' pv ')[1].split(' ')[0],
          cp: score[1] === 'cp' ? Number(score[2]) : null,
          mate: score[1] === 'mate' ? Number(score[2]) : null,
        };
      });
      this.send(`go depth ${plan.depth}`);
      await done;
      return pickMove(lines.filter(Boolean), plan.temperature);
    }
    this.send(`setoption name UCI_LimitStrength value ${plan.mode === 'limit'}`);
    if (plan.mode === 'limit') this.send(`setoption name UCI_Elo value ${plan.elo}`);
    this.send('setoption name MultiPV value 1');
    this.send(position);
    const done = this.until('bestmove');
    this.send(plan.mode === 'limit' ? `go depth ${plan.depth}` : `go movetime ${plan.movetime}`);
    return (await done).split(' ')[1];
  }
}

// White's score: 1, 0.5 or 0.
async function playGame(engine, white, black) {
  const chess = new Chess();
  const moves = [];
  engine.send('ucinewgame');
  await engine.ready();
  while (!chess.isGameOver() && moves.length < MAX_PLIES) {
    const plan = PLAYERS[chess.turn() === 'w' ? white : black];
    const uci = await engine.move(plan, moves, chess.moves().length);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    moves.push(uci);
  }
  if (chess.isCheckmate()) return chess.turn() === 'w' ? 0 : 1;
  return 0.5;
}

// Ratings that best explain the results, with the anchor held at 1320.
function fit(results) {
  const names = Object.keys(PLAYERS);
  const rating = Object.fromEntries(names.map((n) => [n, 1320]));
  for (let iter = 0; iter < 20000; iter++) {
    const grad = Object.fromEntries(names.map((n) => [n, 0]));
    for (const { a, b, score, games } of results) {
      if (games === 0) continue;
      const expected = 1 / (1 + 10 ** ((rating[b] - rating[a]) / 400));
      grad[a] += score - games * expected;
      grad[b] -= score - games * expected;
    }
    for (const n of names) if (n !== ANCHOR) rating[n] += 0.5 * grad[n];
  }
  return rating;
}

async function main() {
  const tasks = [];
  for (const [a, b] of PAIRINGS) {
    for (let g = 0; g < GAMES; g++) tasks.push({ a, b, aWhite: g % 2 === 0 });
  }
  tasks.sort(() => Math.random() - 0.5);
  const results = PAIRINGS.map(([a, b]) => ({ a, b, score: 0, games: 0, draws: 0 }));
  const started = Date.now();
  let done = 0;

  const engines = await Promise.all(Array.from({ length: ENGINES }, async () => {
    const e = new Engine();
    await e.init();
    return e;
  }));
  await Promise.all(engines.map(async (engine) => {
    for (let task = tasks.pop(); task; task = tasks.pop()) {
      const { a, b, aWhite } = task;
      const whiteScore = await playGame(engine, aWhite ? a : b, aWhite ? b : a);
      const score = aWhite ? whiteScore : 1 - whiteScore;
      const r = results.find((x) => x.a === a && x.b === b);
      r.score += score;
      r.games += 1;
      if (score === 0.5) r.draws += 1;
      done += 1;
      if (done % 50 === 0) console.error(`${done} games, ${Math.round((Date.now() - started) / 1000)}s`);
    }
  }));
  engines.forEach((e) => e.proc.kill());

  for (const r of results) console.log(`${r.a.padEnd(7)} vs ${r.b.padEnd(7)} ${(r.score / r.games * 100).toFixed(0).padStart(3)}%  (${r.games} games, ${r.draws} draws)`);
  const rating = fit(results);
  console.log('\nFitted ratings (anchor sf1320 = 1320):');
  for (const [n, r] of Object.entries(rating).sort((x, y) => x[1] - y[1])) console.log(`  ${n.padEnd(7)} ${Math.round(r)}`);
  // How much wider the gaps between Stockfish's own settings came out than their nominal ratings.
  const sf = Object.keys(NOMINAL).filter((n) => n !== ANCHOR);
  const stretch = sf.reduce((sum, n) => sum + (rating[n] - 1320) * (NOMINAL[n] - 1320), 0)
    / sf.reduce((sum, n) => sum + (NOMINAL[n] - 1320) ** 2, 0);
  console.log(`\nStretch of Stockfish's own scale: ${stretch.toFixed(2)}`);
  const levels = Object.entries(PLAYERS)
    .filter(([, p]) => p.mode === 'pick')
    .map(([n, p]) => ({ rating: Math.round(1320 + (rating[n] - 1320) / stretch), temperature: p.temperature }))
    .sort((a, b) => a.rating - b.rating);
  console.log('LOW_LEVELS (on the nominal scale):');
  for (const l of levels) console.log(`  { rating: ${l.rating}, temperature: ${l.temperature} },`);
  console.log(JSON.stringify({ results, rating, stretch }));
}

main();
