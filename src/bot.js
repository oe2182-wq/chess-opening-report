// The computer you play against: its own Stockfish worker, apart from the analysis engines,
// playing at the strength src/bot-pick.js sets for the chosen rating.
import { botPlan, parseInfo, pickMove } from './bot-pick.js';

const MIN_REPLY_MS = 450; // a reply never lands the instant you let go of a piece
const START_TIMEOUT_MS = 20000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class Bot {
  constructor() {
    this.worker = null;
    this.started = null;
    this.search = null; // { resolve, reject, plan, lines }
    this.stray = 0; // results still to come from searches that were cancelled
  }

  start() {
    if (this.started) return this.started;
    this.started = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The engine took too long to start')), START_TIMEOUT_MS);
      const fail = (error) => {
        clearTimeout(timer);
        reject(error);
        this.search?.reject(error);
        this.search = null;
      };
      try {
        this.worker = new Worker('vendor/stockfish/stockfish-19-lite-single.js');
      } catch (error) {
        fail(error);
        return;
      }
      let ready = false;
      this.worker.onerror = (e) => fail(new Error(e.message || 'The engine stopped'));
      this.worker.onmessage = (e) => {
        const line = String(e.data);
        if (line === 'uciok') {
          this.send('setoption name Hash value 16');
          this.send('isready');
        } else if (line === 'readyok' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve();
        } else {
          this.onLine(line);
        }
      };
      this.send('uci');
    });
    return this.started;
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  // The move to play, as UCI, or null if the search was cancelled. `moves` are UCI moves from `fen`.
  async move({ fen, moves, legal }, rating) {
    await this.start();
    this.cancel();
    const plan = botPlan(rating);
    const began = performance.now();
    const uci = await new Promise((resolve, reject) => {
      this.search = { resolve, reject, plan, lines: [] };
      const pick = plan.mode === 'pick';
      this.send(`setoption name UCI_LimitStrength value ${plan.mode === 'limit'}`);
      if (plan.mode === 'limit') this.send(`setoption name UCI_Elo value ${plan.elo}`);
      this.send(`setoption name MultiPV value ${pick ? legal : 1}`);
      this.send(`position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
      if (pick) this.send(`go depth ${plan.depth}`);
      else if (plan.mode === 'limit') this.send(`go depth ${plan.depth} movetime ${plan.movetime}`);
      else this.send(`go movetime ${plan.movetime}`);
    });
    if (uci == null) return null;
    const wait = MIN_REPLY_MS - (performance.now() - began);
    if (wait > 0) await sleep(wait);
    return uci;
  }

  cancel() {
    if (!this.search) return;
    this.search.resolve(null);
    this.search = null;
    this.stray += 1;
    this.send('stop');
  }

  onLine(line) {
    if (line.startsWith('bestmove')) {
      if (this.stray > 0) { this.stray -= 1; return; }
      const search = this.search;
      if (!search) return;
      this.search = null;
      const best = line.split(' ')[1];
      const lines = search.lines.filter(Boolean);
      search.resolve(search.plan.mode === 'pick' && lines.length > 0 ? pickMove(lines, search.plan.temperature) : best);
    } else if (this.stray === 0 && this.search?.plan.mode === 'pick') {
      const info = parseInfo(line);
      if (info) this.search.lines[info.index] = info;
    }
  }
}
