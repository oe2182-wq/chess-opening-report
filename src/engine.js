// Runs Stockfish in two workers. One searches the position on the board; the other, and
// the first once it finishes, works through the moves likely to come next and stores the
// results, so a move already thought about shows its lines at once. Lines are reported
// from White's point of view so the UI never has to think about side to move.
import { Chess } from '../vendor/chess.js';

export const ENGINE_NAME = 'Stockfish 19 Lite';

const WORKERS = 2;
const HASH_MB = 128;
const CACHE_SIZE = 3000;
const PONDER_PLIES = 3; // how many moves ahead of the board to look
const PONDER_FROM_DEPTH = 12; // the board's lines are worth following from here
const FIRST_PONDER_DEPTH = 16;
const PONDER_DEPTH_STEP = 4;

// The side to move, castling and en passant decide a position; the move counters don't.
const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

function childFen(fen, uci) {
  const chess = new Chess(fen);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return chess.isGameOver() ? null : chess.fen();
}

class Searcher {
  constructor({ onInfo, onDone }) {
    this.onInfo = onInfo;
    this.onDone = onDone;
    this.worker = new Worker('vendor/stockfish/stockfish-19-lite-single.js');
    this.worker.onmessage = (e) => this.handle(String(e.data));
    this.ready = false;
    this.job = null; // the search in the worker
    this.next = null; // waits for that search to stop
    this.send('uci');
  }

  get free() {
    return !this.next && (!this.job || this.job.cancelled);
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  run(job) {
    this.next = job;
    if (this.job) this.cancel(false);
    else this.startNext();
  }

  cancel(clearNext = true) {
    if (clearNext) this.next = null;
    if (this.job && !this.job.cancelled) {
      this.job.cancelled = true;
      this.send('stop');
    }
  }

  startNext() {
    if (!this.ready || !this.next) return;
    const job = this.next;
    this.next = null;
    this.job = job;
    this.send(`setoption name MultiPV value ${job.lines}`);
    this.send(`position fen ${job.fen}`);
    this.send(`go depth ${job.depth}`);
  }

  handle(line) {
    if (line === 'uciok') {
      this.send(`setoption name Hash value ${HASH_MB}`);
      this.send('isready');
    } else if (line === 'readyok') {
      this.ready = true;
      this.startNext();
    } else if (line.startsWith('bestmove')) {
      const finished = this.job;
      this.job = null;
      this.startNext();
      this.onDone(finished);
    } else if (line.startsWith('info ') && line.includes(' pv ')) {
      this.handleInfo(line);
    }
  }

  handleInfo(line) {
    const { job } = this;
    if (!job || job.cancelled) return; // result of a search we've already moved on from
    if (line.includes('lowerbound') || line.includes('upperbound')) return;

    const number = (key) => Number(line.match(new RegExp(` ${key} (-?\\d+)`))?.[1]);
    const depth = number('depth');
    const index = (number('multipv') || 1) - 1;
    const score = line.match(/ score (cp|mate) (-?\d+)/);
    if (!score) return;

    const sign = job.fen.split(' ')[1] === 'w' ? 1 : -1;
    job.results[index] = {
      cp: score[1] === 'cp' ? sign * Number(score[2]) : null,
      mate: score[1] === 'mate' ? sign * Number(score[2]) : null,
      pv: line.split(' pv ')[1].trim().split(' '),
    };
    job.depthReached = Math.max(job.depthReached, depth);
    this.onInfo(job, index === job.lines - 1);
  }
}

export class Engine {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.cache = new Map(); // positionKey -> { depth, lines }
    this.target = null; // the position on the board
    this.queue = [];
    this.searchers = Array.from({ length: WORKERS }, () => new Searcher({
      onInfo: (job, depthComplete) => this.onInfo(job, depthComplete),
      onDone: (job) => this.onDone(job),
    }));
  }

  analyze(fen, { lines, depth, ponder }) {
    const key = positionKey(fen);
    this.target = { fen, key, lines, depth, ponder, shownDepth: 0 };
    this.queue = [];
    this.candidates = new Map();
    this.ponderDepth = Math.min(FIRST_PONDER_DEPTH, depth);

    for (const searcher of this.searchers) {
      const { job } = searcher;
      if (job && !job.cancelled && job.key === key && job.lines === lines) job.live = true;
      else searcher.cancel();
    }

    const known = this.known(key, lines);
    if (known) {
      this.target.shownDepth = known.depth;
      this.onUpdate({ fen, depth: known.depth, lines: known.lines.slice(0, lines) });
      this.addCandidates(known.lines, fen, 0);
    }
    this.pump();
  }

  stop() {
    this.target = null;
    this.queue = [];
    for (const searcher of this.searchers) searcher.cancel();
  }

  known(key, lines) {
    const entry = this.cache.get(key);
    return entry && entry.lines.length >= lines ? entry : null;
  }

  remember(job) {
    const entry = this.cache.get(job.key);
    if (entry && (entry.depth > job.depthReached || entry.lines.length > job.results.length)) return;
    this.cache.delete(job.key); // re-inserting keeps the Map in least-recently-stored order
    this.cache.set(job.key, { depth: job.depthReached, lines: job.results.slice() });
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value);
  }

  addCandidates(lines, fen, ply) {
    if (!this.target?.ponder || ply >= PONDER_PLIES) return;
    for (const { pv } of lines) {
      const next = childFen(fen, pv[0]);
      if (!next || this.candidates.has(positionKey(next))) continue;
      const job = {
        fen: next,
        key: positionKey(next),
        ply: ply + 1,
        lines: Math.min(this.target.lines, new Chess(next).moves().length),
      };
      this.candidates.set(job.key, job);
      this.queue.push(job);
    }
    this.queue.sort((a, b) => a.ply - b.ply);
  }

  makeJob(position, depth, live) {
    return { ...position, depth, live, results: [], depthReached: 0, cancelled: false };
  }

  // The board's position comes first; any searcher left over thinks ahead.
  pump() {
    if (!this.target) return;
    const { target } = this;
    const searching = (key) => this.searchers.some((s) => {
      const job = s.next ?? s.job;
      return job && !job.cancelled && job.key === key;
    });
    const needed = (this.known(target.key, target.lines)?.depth ?? 0) < target.depth;
    if (needed && !searching(target.key)) {
      this.searchers.find((s) => s.free)?.run(this.makeJob(target, target.depth, true));
    }

    for (const searcher of this.searchers) {
      while (searcher.free && this.queue.length > 0) {
        const position = this.queue.shift();
        const known = this.known(position.key, position.lines);
        if (known?.depth >= this.ponderDepth) this.addCandidates(known.lines, position.fen, position.ply);
        else if (!searching(position.key)) searcher.run(this.makeJob(position, this.ponderDepth, false));
      }
    }

    // Everything has been looked at to this depth, so go round again deeper.
    const idle = this.searchers.every((s) => !s.job && !s.next);
    if (idle && this.queue.length === 0 && this.candidates.size > 0 && this.ponderDepth < target.depth) {
      this.ponderDepth = Math.min(this.ponderDepth + PONDER_DEPTH_STEP, target.depth);
      this.queue = [...this.candidates.values()].sort((a, b) => a.ply - b.ply);
      this.pump();
    }
  }

  onInfo(job, depthComplete) {
    if (depthComplete) this.remember(job);
    if (!job.live || this.target?.key !== job.key) return;
    const { target } = this;
    if (job.depthReached < target.shownDepth) return;
    target.shownDepth = job.depthReached;
    this.onUpdate({ fen: target.fen, depth: job.depthReached, lines: job.results.filter(Boolean) });
    if (depthComplete && job.depthReached >= PONDER_FROM_DEPTH) {
      this.addCandidates(job.results, target.fen, 0);
      this.pump();
    }
  }

  onDone(job) {
    if (job && !job.cancelled && !job.live) {
      const entry = this.cache.get(job.key);
      if (entry) this.addCandidates(entry.lines, job.fen, job.ply);
    }
    this.pump();
  }
}
