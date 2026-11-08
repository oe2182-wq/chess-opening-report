import { createGame, playMove } from './tree.js';

// A lesson as a game, with every step's moves in the tree. The first path
// played becomes the main line; later ones become variations.
export function lessonToGame(lesson) {
  const game = createGame(lesson.fen);
  game.headers = { White: lesson.white ?? 'White', Black: lesson.black ?? 'Black' };
  const nodes = lesson.steps.map((step) => {
    let node = game.root;
    for (const san of step.moves.split(' ').filter(Boolean)) node = playMove(node, san);
    return node;
  });
  return { game, nodes };
}

export async function fetchLesson(id) {
  const response = await fetch(`assets/lessons/${encodeURIComponent(id)}.json`);
  if (!response.ok) throw new Error(`No lesson called ${id}`);
  return response.json();
}
