import { Chess } from '../vendor/chess.js';
import { Board } from './board.js';
import { Bot } from './bot.js';
import { MAX_RATING } from './bot-pick.js';
import { Engine } from './engine.js';
import { fetchLesson, lessonToGame } from './lesson.js';
import { Panel } from './panel.js';
import { Report } from './report.js';
import { lineToGame, pickSequence, recordRun } from './repertoire.js';
import { createGame, isWhiteMove, loadText, mainLine, playMove, toPgn } from './tree.js';

const SETTINGS_KEY = 'analysis-settings';
const LAYOUT = { pad: 16, playerRows: 100, evalColumn: 43, gap: 32 };
const REPLY_DELAY = 450;
const MISSES_BEFORE_HINT = 2;
const LESSON_MOVE_DELAY = 900;

function readSettings() {
  const defaults = { engineOn: true, lines: 3, depth: 24, showArrow: true, thinkAhead: true, repertoire: null, botRating: 1500, botColor: 'w', explorerDb: 'lichess' };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY)) };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    // Settings simply won't persist in this browser.
  }
}

const state = {
  game: createGame(),
  node: null,
  orientation: 'w',
  settings: readSettings(),
  analysis: { depth: 0, lines: [] },
  openings: {},
  repertoires: [],
  study: null, // { repertoire, line } while a line is open for study
  practice: null, // { repertoire, lines, entry, ply, misses, tries, hinted, arrow, wrong, done, reply } during a drill
  lesson: null, // { lesson, nodes, step } while a lesson is open
  play: null, // { rating, color, choice, tip, thinking, request, over, failed } during a game against the computer
  explorer: null, // what humans played, from assets/explorer.json: null until asked for, then 'loading', 'failed' or the data
};
state.node = state.game.root;

const boardEl = document.getElementById('board');
const evalEl = document.getElementById('eval');
const evalWhite = document.getElementById('eval-white');
const evalScore = document.getElementById('eval-score');
const toastEl = document.getElementById('toast');

const board = new Board(boardEl, {
  legalMoves(square) {
    if (state.practice && !isPracticeTurn()) return [];
    if (state.play && !isPlayerTurn()) return [];
    return new Chess(state.node.fen)
      .moves({ square, verbose: true })
      .map((m) => ({ to: m.to, promotion: m.promotion, capture: m.isCapture() || m.isEnPassant() }));
  },
  onMove(move) {
    clearTimeout(lessonTimer);
    if (state.practice) practiceMove(move);
    else if (state.play) playerMove(move);
    else goTo(playMove(state.node, move));
  },
});

const engine = new Engine((update) => {
  if (update.fen !== state.node.fen) return;
  state.analysis = update;
  scheduleEngineRender();
});

const report = new Report();
const bot = new Bot();

function openReportGame() {
  const pgn = report.currentPgn;
  if (!pgn) return;
  stopPlay();
  state.study = null;
  state.lesson = null;
  faceColor('w');
  panel.setTab('analysis');
  setGame(loadText(pgn));
}

const panel = new Panel(document.getElementById('sidebar'), {
  state,
  report,
  openReportGame,
  goTo,
  playLine(node, uciMoves) {
    let current = node;
    for (const uci of uciMoves) current = playMove(current, uciToMove(uci));
    goTo(current);
  },
  loadText(text) {
    const game = loadText(text);
    stopPlay();
    report.close();
    state.study = null;
    state.lesson = null;
    setGame(game);
  },
  newGame() {
    stopPlay();
    report.close();
    state.study = null;
    state.lesson = null;
    setGame(createGame());
  },
  lessonStep: (delta) => showLessonStep(state.lesson.step + delta, { animate: delta > 0 }),
  closeLesson() {
    state.lesson = null;
    goTo(state.node);
  },
  flip,
  selectRepertoire(id) {
    state.settings.repertoire = id;
    saveSettings();
  },
  studyLine,
  startPractice,
  nextPractice: () => nextPractice(),
  stopPractice,
  showHint,
  closeStudy() {
    state.study = null;
  },
  setSetting(key, value) {
    state.settings[key] = value;
    saveSettings();
    if (key === 'showArrow') renderEngineArrow();
    else analyze();
    panel.renderAnalysis();
  },
  setPref(key, value) {
    state.settings[key] = value;
    saveSettings();
  },
  playSan: (san) => goTo(playMove(state.node, san)),
  // Loaded the first time the Explore tab opens: it's a few megabytes.
  loadExplorer() {
    if (state.explorer) return;
    state.explorer = 'loading';
    fetch('assets/explorer.json')
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((data) => { state.explorer = data; })
      .catch(() => { state.explorer = 'failed'; })
      .finally(() => panel.renderAll());
  },
  startPlay: (fromHere) => startPlay(state.settings.botRating, state.settings.botColor, fromHere ? positionOf(state.node) : null),
  rematch: () => startPlay(state.play.rating, state.play.choice, state.play.from, state.play.source),
  backToGame,
  takeback,
  resign,
  closePlay,
  newPlay() {
    stopPlay();
    faceColor(state.settings.botColor === 'b' ? 'b' : 'w');
    setGame(createGame());
  },
  copyFen: () => copy(state.node.fen, 'FEN copied'),
  copyPgn: () => copy(toPgn(state.game), 'PGN copied'),
  downloadPgn,
});

function uciToMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] };
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toastEl.hidden = true; }, 1800);
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    showToast('Copying was blocked by the browser');
  }
}

function downloadPgn() {
  const url = URL.createObjectURL(new Blob([toPgn(state.game)], { type: 'application/x-chess-pgn' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'analysis.pgn';
  a.click();
  URL.revokeObjectURL(url);
}

function setGame(game) {
  state.game = game;
  state.node = game.root;
  panel.renderAll();
  goTo(game.root);
}

function goTo(node) {
  state.node = node;
  board.setPosition(node.fen, node.from ? { from: node.from, to: node.to } : null);
  state.analysis = { depth: 0, lines: [] };
  board.setEngineArrow(null);
  panel.renderAll();
  renderPlayers();
  analyze();
}

function flip() {
  state.orientation = state.orientation === 'w' ? 'b' : 'w';
  board.setOrientation(state.orientation);
  evalEl.classList.toggle('flipped', state.orientation === 'b');
  renderPlayers();
}

function faceColor(color) {
  if (state.orientation !== color) flip();
}

async function openLesson(id) {
  try {
    const lesson = await fetchLesson(id);
    stopPlay();
    state.study = null;
    state.lesson = { lesson, ...lessonToGame(lesson), step: 0 };
    faceColor(lesson.orientation ?? 'w');
    setGame(state.lesson.game);
    showLessonStep(0);
  } catch {
    showToast(`Couldn't open the lesson "${id}"`);
  }
}

let lessonTimer = null;

// Going forward plays the step's moves one at a time from where the board
// last agreed with them, so a long line can be followed. Going back jumps.
function showLessonStep(index, { animate = false } = {}) {
  const { lesson, nodes } = state.lesson;
  clearTimeout(lessonTimer);
  const step = Math.max(0, Math.min(nodes.length - 1, index));
  state.lesson.step = step;
  const target = nodes[step];
  const finish = () => {
    boardEl.classList.remove('slow-moves');
    goTo(target);
    board.setAnnotations(lesson.steps[step]);
  };

  const path = [];
  if (animate) {
    const shown = new Set();
    for (let n = state.node; n; n = n.parent) shown.add(n);
    for (let n = target; n && !shown.has(n); n = n.parent) path.unshift(n);
  }
  if (path.length < 2) { finish(); return; }

  boardEl.classList.add('slow-moves');
  goTo(path[0].parent);
  const playNext = (i) => {
    if (i === path.length - 1) { lessonTimer = setTimeout(finish, LESSON_MOVE_DELAY); return; }
    lessonTimer = setTimeout(() => { goTo(path[i]); playNext(i + 1); }, LESSON_MOVE_DELAY);
  };
  playNext(0);
}

function studyLine(repertoire, line) {
  const { game, key } = lineToGame(line);
  stopPlay();
  state.study = { repertoire, line };
  state.lesson = null;
  faceColor(repertoire.color);
  setGame(game);
  goTo(key);
}

const isPracticeTurn = () => {
  const { practice, node } = state;
  return !practice.done && node.fen.split(' ')[1] === practice.repertoire.color;
};

function startPractice(repertoire, lines) {
  stopPlay();
  state.study = null;
  state.lesson = null;
  state.practice = { repertoire, lines, entry: null };
  faceColor(repertoire.color);
  nextPractice();
}

function nextPractice() {
  const practice = state.practice;
  clearTimeout(practice.reply);
  const entry = pickSequence(practice.repertoire, practice.lines, practice.entry?.moves);
  Object.assign(practice, { entry, ply: 0, misses: 0, tries: 0, hinted: false, arrow: false, done: false, wrong: false });
  setGame(createGame());
  queuePracticeReply();
}

function showHint() {
  const { practice } = state;
  practice.hinted = true;
  practice.arrow = true;
  const move = new Chess(state.node.fen).move(practice.entry.moves[practice.ply]);
  board.setEngineArrow({ from: move.from, to: move.to });
  panel.renderPractice();
}

function practiceMove(move) {
  const { practice } = state;
  const { moves } = practice.entry;
  if (new Chess(state.node.fen).move(move).san !== moves[practice.ply]) {
    practice.misses += 1;
    practice.tries += 1;
    practice.wrong = true;
    panel.renderPractice();
    if (practice.tries >= MISSES_BEFORE_HINT) showHint();
    return;
  }
  Object.assign(practice, { tries: 0, wrong: false, arrow: false });
  advancePractice();
}

function advancePractice() {
  const { practice } = state;
  const san = practice.entry.moves[practice.ply];
  practice.ply += 1;
  practice.done = practice.ply === practice.entry.moves.length;
  if (practice.done) recordRun(practice.repertoire, practice.entry.moves, practice.misses === 0 && !practice.hinted);
  goTo(playMove(state.node, san));
  queuePracticeReply();
}

function queuePracticeReply() {
  const { practice } = state;
  if (practice.done || isPracticeTurn()) return;
  practice.reply = setTimeout(advancePractice, REPLY_DELAY);
}

// Leaves the position on the board, so the line can be analyzed from where it stopped.
function stopPractice() {
  clearTimeout(state.practice.reply);
  state.practice = null;
  goTo(state.node);
  renderEval();
}

// Playing the computer. The game is the main line of state.game; you move only at its end
// (play.tip), but can step back through it meanwhile. The analysis engine stays off until the
// game is over and you leave it, so the eval bar and lines can't give moves away.
const turnOf = (node) => node.fen.split(' ')[1];
const moverOf = (node) => (isWhiteMove(node) ? 'w' : 'b');

function pathTo(node) {
  const path = [];
  for (let n = node; n.parent; n = n.parent) path.unshift(n);
  return path;
}

const isPlayerTurn = () => {
  const { play, node } = state;
  return !play.over && !play.thinking && node === play.tip && turnOf(node) === play.color;
};

function pgnDate() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// A position to play from: the moves that lead to it, so the game keeps its history.
function positionOf(node) {
  return { fen: state.game.root.fen, sans: pathTo(node).map((n) => n.san) };
}

// `from` is null for the starting position. `source` remembers the report game it came from,
// so you can go back to it afterwards.
function startPlay(rating, choice, from = null, source = undefined) {
  const origin = source !== undefined ? source
    : from && report.current ? { leafId: report.leafId, index: report.index, ply: from.sans.length } : null;
  stopPlay();
  if (state.practice) stopPractice();
  report.close();
  state.study = null;
  state.lesson = null;
  const color = choice === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : choice;
  const game = from ? createGame(from.fen) : createGame();
  let start = game.root;
  for (const san of from?.sans ?? []) start = playMove(start, san);
  const computer = rating >= MAX_RATING ? 'Computer (Max)' : 'Computer';
  const side = (c) => (c === color ? 'You' : computer);
  game.headers = { Event: 'Play vs Computer', Date: pgnDate(), White: side('w'), Black: side('b') };
  if (rating < MAX_RATING) game.headers[color === 'w' ? 'BlackElo' : 'WhiteElo'] = String(rating);
  game.headers.Result = '*';
  state.play = { rating, color, choice, from, source: origin, start, tip: start, thinking: false, request: 0, over: null, failed: false };
  faceColor(color);
  setGame(game);
  if (start !== game.root) goTo(start);
  computerTurn();
}

// Reopens the report game a game against the computer started from, at the move you left it.
function backToGame() {
  const source = state.play?.source;
  if (!source) return;
  report.leafId = source.leafId;
  report.index = source.index;
  openReportGame();
  if (source.ply > 0) goTo(mainLine(state.game.root)[source.ply - 1] ?? state.game.root);
}

function playerMove(move) {
  const { play } = state;
  play.confirmResign = false;
  play.tip = playMove(play.tip, move);
  goTo(play.tip);
  if (!finishIfOver()) computerTurn();
}

async function computerTurn() {
  const { play } = state;
  if (!play || play.over || turnOf(play.tip) === play.color) return;
  const request = ++play.request;
  play.thinking = true;
  panel.renderAll();
  const uciOf = (n) => n.from + n.to + (n.san.match(/=([QRBN])/)?.[1].toLowerCase() ?? '');
  const position = {
    fen: state.game.root.fen,
    moves: pathTo(play.tip).map(uciOf),
    legal: new Chess(play.tip.fen).moves().length,
  };
  let uci;
  try {
    uci = await bot.move(position, play.rating);
  } catch {
    if (state.play === play && play.request === request) {
      play.thinking = false;
      play.failed = true;
      panel.renderAll();
    }
    return;
  }
  if (state.play !== play || play.request !== request || play.over || !uci) return;
  play.thinking = false;
  play.tip = playMove(play.tip, uciToMove(uci));
  goTo(play.tip);
  finishIfOver();
}

// Rebuilt from the moves, so repetitions count.
function gameOverAt(node) {
  const chess = new Chess(state.game.root.fen);
  for (const n of pathTo(node)) chess.move(n.san);
  if (chess.isCheckmate()) return { winner: chess.turn() === 'w' ? 'b' : 'w', reason: 'checkmate' };
  if (chess.isStalemate()) return { winner: null, reason: 'stalemate' };
  if (chess.isThreefoldRepetition()) return { winner: null, reason: 'repetition' };
  if (chess.isInsufficientMaterial()) return { winner: null, reason: 'insufficient material' };
  if (chess.isDraw()) return { winner: null, reason: '50-move rule' };
  return null;
}

function finishIfOver() {
  const over = gameOverAt(state.play.tip);
  if (over) endPlay(over);
  return !!over;
}

function endPlay(over) {
  const { play } = state;
  bot.cancel();
  play.request += 1;
  play.thinking = false;
  play.over = over;
  state.game.headers.Result = over.winner === 'w' ? '1-0' : over.winner === 'b' ? '0-1' : '1/2-1/2';
  panel.renderAll();
}

function resign() {
  const { play } = state;
  if (!play || play.over) return;
  if (!play.confirmResign) {
    play.confirmResign = true;
    panel.renderAll();
    return;
  }
  endPlay({ winner: play.color === 'w' ? 'b' : 'w', reason: 'resignation' });
}

// Back to the position before your last move, and the moves after it are gone. Moves from
// before the game started can't be taken back.
function takeback() {
  const { play } = state;
  if (!play || play.over) return;
  const played = pathTo(play.tip).slice(pathTo(play.start).length);
  const yours = played.filter((n) => moverOf(n) === play.color).at(-1);
  if (!yours) return;
  bot.cancel();
  play.request += 1;
  play.thinking = false;
  play.confirmResign = false;
  play.tip = yours.parent;
  play.tip.children = [];
  goTo(play.tip);
}

// Ends a game that's in progress, if there is one; what's on the board is left to the caller.
function stopPlay() {
  if (!state.play) return;
  bot.cancel();
  state.play = null;
}

// Keeps the finished game on the board and turns analysis back on.
function closePlay() {
  stopPlay();
  goTo(state.node);
}

// Game-over positions have nothing to search; the eval bar reports the result.
function terminalResult(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return { text: chess.turn() === 'w' ? '0-1' : '1-0', white: chess.turn() === 'w' ? 0 : 100 };
  if (chess.isDraw()) return { text: '½-½', white: 50 };
  return null;
}

function analyze() {
  const terminal = terminalResult(state.node.fen);
  const { engineOn, lines, depth, thinkAhead } = state.settings;
  if (!engineOn || terminal || state.practice || state.play) {
    engine.stop();
    board.setEngineArrow(null);
    renderEval();
    panel.renderEngine();
    return;
  }
  const legal = new Chess(state.node.fen).moves().length;
  engine.analyze(state.node.fen, { lines: Math.min(lines, legal), depth, ponder: thinkAhead });
  panel.renderEngine();
}

let renderQueued = false;
function scheduleEngineRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    panel.renderEngine();
    renderEval();
    renderEngineArrow();
  }, 80);
}

// A lesson draws its own arrows; the engine's would compete with them.
function renderEngineArrow() {
  if (state.practice || state.lesson || state.play) return;
  const best = state.analysis.lines[0]?.pv[0];
  const show = best && state.settings.showArrow && state.settings.engineOn;
  board.setEngineArrow(show ? { from: best.slice(0, 2), to: best.slice(2, 4) } : null);
}

// The share of the bar that is white, for a score in centipawns from White's side.
function whiteShare(line) {
  if (line.mate != null) return line.mate > 0 ? 100 : 0;
  return Math.max(5, Math.min(95, 50 + 50 * Math.tanh(line.cp / 445)));
}

function renderEval() {
  const terminal = terminalResult(state.node.fen);
  const line = state.analysis.lines[0];
  let share = 50;
  let label = '';
  let whiteAhead = true;

  if (terminal) {
    share = terminal.white;
    label = terminal.text;
    whiteAhead = terminal.white >= 50;
  } else if (line && state.settings.engineOn && !state.practice && !state.play) {
    share = whiteShare(line);
    whiteAhead = line.mate != null ? line.mate > 0 : line.cp >= 0;
    label = line.mate != null ? `M${Math.abs(line.mate)}` : Math.abs(line.cp / 100).toFixed(1);
  }
  evalEl.classList.toggle('hidden-eval', !state.settings.engineOn || !!state.practice || !!state.play);
  evalWhite.style.transform = `translateY(${100 - share}%)`;
  evalScore.textContent = label;
  evalScore.classList.toggle('on-white', whiteAhead);
  evalScore.classList.toggle('on-black', !whiteAhead);
}

function formatClock(seconds) {
  if (seconds == null) return null;
  const total = Math.max(0, seconds);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function clockAt(color) {
  const firstClock = mainLine(state.game.root).find((n) => (isWhiteMove(n) ? 'w' : 'b') === color)?.clock;
  if (firstClock == null) return null;
  for (let n = state.node; n; n = n.parent) {
    if (n.san && (isWhiteMove(n) ? 'w' : 'b') === color && n.clock != null) return n.clock;
  }
  const [base] = (state.game.headers.TimeControl ?? '').split('+').map(Number);
  return base || firstClock;
}

function renderPlayer(el, color) {
  const headers = state.game.headers;
  const name = color === 'w' ? headers.White : headers.Black;
  const elo = color === 'w' ? headers.WhiteElo : headers.BlackElo;
  const clock = formatClock(clockAt(color));
  const active = state.node.fen.split(' ')[1] === color;
  const fallback = color === 'w' ? 'White' : 'Black';
  const shown = name && name !== '?' ? name : fallback;
  el.innerHTML = `
    <div class="avatar avatar-${color}"><img src="assets/pieces/${color}P.png" alt=""></div>
    <span class="player-name"></span>
    ${elo && elo !== '?' ? `<span class="player-rating">(${Number(elo) || ''})</span>` : ''}
    ${clock ? `<div class="clock ${active ? 'clock-active' : 'clock-idle'} ${color === 'w' ? 'clock-white' : 'clock-black'}">${clock}</div>` : ''}`;
  el.querySelector('.player-name').textContent = shown;
}

function renderPlayers() {
  const top = state.orientation === 'w' ? 'b' : 'w';
  renderPlayer(document.getElementById('player-top'), top);
  renderPlayer(document.getElementById('player-bottom'), top === 'w' ? 'b' : 'w');
}

// The board must stay an exact multiple of 8 so squares never land on half pixels.
// On a phone the sidebar moves under the board and the board takes the full width.
function layout() {
  const mobile = window.innerWidth < 760;
  document.documentElement.classList.toggle('mobile', mobile);
  const sidebarWidth = mobile ? 0 : window.innerWidth >= 1200 ? 400 : 300;
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  const byHeight = mobile ? Infinity : window.innerHeight - LAYOUT.pad * 2 - LAYOUT.playerRows;
  const byWidth = window.innerWidth - LAYOUT.pad * 2 - sidebarWidth - LAYOUT.evalColumn - (mobile ? 0 : LAYOUT.gap);
  const size = Math.max(240, Math.min(byHeight, byWidth));
  const snapped = size - (size % 8);
  document.documentElement.style.setProperty('--board-size', `${snapped}px`);
  document.documentElement.style.setProperty('--square', `${snapped / 8}px`);
}

function stepTo(direction) {
  if (state.practice) return;
  clearTimeout(lessonTimer);
  boardEl.classList.remove('slow-moves');
  const { node } = state;
  const line = (start) => { const l = [start]; while (l.at(-1).children[0]) l.push(l.at(-1).children[0]); return l; };
  if (direction === 'first') goTo(state.game.root);
  else if (direction === 'prev' && node.parent) goTo(node.parent);
  else if (direction === 'next' && node.children[0]) goTo(node.children[0]);
  else if (direction === 'last') goTo(line(node).at(-1));
}
panel.stepTo = stepTo;

window.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input, select')) return;
  const keys = { ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'first', ArrowDown: 'last' };
  if (state.lesson && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const forward = e.key === 'ArrowRight';
    showLessonStep(state.lesson.step + (forward ? 1 : -1), { animate: forward });
  } else if (keys[e.key]) {
    e.preventDefault();
    stepTo(keys[e.key]);
  } else if (e.key === 'f') {
    flip();
  }
});

window.addEventListener('resize', layout);

layout();
goTo(state.game.root);
renderEval();
report.ready.then(() => panel.renderBody()).catch(() => {
  // The Games tab keeps saying it's loading; the board works without the report.
});

const lessonId = new URLSearchParams(location.search).get('lesson');
if (lessonId) openLesson(lessonId);

fetch('assets/openings.json')
  .then((r) => r.json())
  .then((data) => {
    state.openings = data;
    panel.renderOpening();
  })
  .catch(() => {
    // The opening name is cosmetic; analysis carries on without it.
  });

fetch('assets/repertoires.json')
  .then((r) => r.json())
  .then((data) => {
    state.repertoires = data;
    panel.renderBody();
  })
  .catch(() => {
    // The Repertoire tab says so when there are none to pick from.
  });
