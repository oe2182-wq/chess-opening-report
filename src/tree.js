import { Chess } from '../vendor/chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let nextId = 1;

function makeNode(parent, fen, move) {
  return {
    id: nextId++,
    parent,
    children: [], // children[0] continues the line, the rest are variations
    fen,
    san: move?.san ?? null,
    from: move?.from ?? null,
    to: move?.to ?? null,
    clock: null, // seconds left after this move
    spent: null, // seconds spent on this move
  };
}

export function createGame(fen = START_FEN) {
  return { root: makeNode(null, fen), headers: {} };
}

export const isWhiteMove = (node) => node.fen.split(' ')[1] === 'b';

// Full-move number of the move that produced this node.
export function moveNumber(node) {
  const full = Number(node.fen.split(' ')[5]);
  return isWhiteMove(node) ? full : full - 1;
}

export function mainLine(root) {
  const line = [];
  for (let n = root.children[0]; n; n = n.children[0]) line.push(n);
  return line;
}

// Plays a move from `node`, reusing an existing branch when it already exists.
export function playMove(node, moveInput) {
  const chess = new Chess(node.fen);
  const move = chess.move(moveInput);
  const existing = node.children.find((c) => c.san === move.san);
  if (existing) return existing;
  const child = makeNode(node, chess.fen(), move);
  node.children.push(child);
  return child;
}

function parseClock(text) {
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

function applyClocks(game, pgn) {
  const clocks = [...pgn.matchAll(/\[%clk\s+([\d:.]+)\]/g)].map((m) => parseClock(m[1]));
  const line = mainLine(game.root);
  if (clocks.length === 0 || clocks.length > line.length) return;

  const [base, inc] = (game.headers.TimeControl ?? '').split('+').map(Number);
  const last = { w: base || null, b: base || null };
  line.slice(0, clocks.length).forEach((node, i) => {
    const side = isWhiteMove(node) ? 'w' : 'b';
    node.clock = clocks[i];
    if (last[side] != null) node.spent = Math.max(0, last[side] + (inc || 0) - clocks[i]);
    last[side] = clocks[i];
  });
}

// Accepts a PGN or a FEN. Throws if the text is neither.
export function loadText(text) {
  const input = text.trim();
  if (input === '') return createGame();

  if (/^[1-8pnbrqkPNBRQK/]+ [wb] /.test(input)) {
    const chess = new Chess(input); // validates
    return createGame(chess.fen());
  }

  const chess = new Chess();
  chess.loadPgn(input);
  const history = chess.history({ verbose: true });
  const headers = chess.getHeaders();
  const game = createGame(history[0]?.before ?? chess.fen());
  game.headers = headers;

  let node = game.root;
  for (const move of history) node = playMove(node, move.san);
  applyClocks(game, input);
  return game;
}

// Alternatives to a move are written right after it, before the line continues.
function lineToPgn(node, alternatives, withNumber) {
  const number = isWhiteMove(node) ? `${moveNumber(node)}. ` : withNumber ? `${moveNumber(node)}... ` : '';
  const parts = [number + node.san];
  for (const alt of alternatives) parts.push(`(${lineToPgn(alt, [], true)})`);
  const [next, ...variations] = node.children;
  if (next) parts.push(lineToPgn(next, variations, alternatives.length > 0));
  return parts.join(' ');
}

export function toPgn(game) {
  const headers = { ...game.headers };
  if (game.root.fen !== START_FEN) {
    headers.SetUp = '1';
    headers.FEN = game.root.fen;
  }
  const tags = Object.entries(headers).map(([k, v]) => `[${k} "${v}"]`).join('\n');
  const [first, ...alternatives] = game.root.children;
  const moves = first ? lineToPgn(first, alternatives, true) : '';
  return `${tags}${tags ? '\n\n' : ''}${moves} ${headers.Result ?? '*'}`.trim() + '\n';
}
