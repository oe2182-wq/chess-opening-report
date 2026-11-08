// Your rapid games as White, grouped the way the engine review grouped them: opening,
// variation, line. A line with no further split opens its games on the board one at a time.

export class Report {
  constructor() {
    this.nodes = [];
    this.games = [];
    this.pgns = {};
    this.listId = 'white'; // the level the Games tab lists
    this.leafId = null; // the line whose games are on the board
    this.index = 0;
    this.ready = Promise.all(['nodes', 'games', 'pgns'].map((name) => fetch(`assets/report/${name}.json`).then((r) => r.json())))
      .then(([nodes, games, pgns]) => {
        this.nodes = nodes;
        this.games = games;
        this.pgns = pgns;
      });
  }

  node(id) {
    return this.nodes.find((n) => n.id === id) ?? null;
  }

  children(id) {
    return this.nodes.filter((n) => n.parent === id).sort((a, b) => b.games - a.games || a.order - b.order);
  }

  // From White down to `id`.
  path(id) {
    const chain = [];
    for (let n = this.node(id); n; n = this.node(n.parent)) chain.unshift(n);
    return chain;
  }

  share(n) {
    const parent = this.node(n.parent);
    return parent ? n.games / parent.games : null;
  }

  gamesOf(id) {
    return this.games.filter((g) => id === 'white' || g.node === id || g.node.startsWith(`${id}.`));
  }

  // 'list' when `id` splits further, 'game' when its games are now open.
  open(id) {
    const n = this.node(id);
    if (!n) return null;
    if (n.children > 0) {
      this.listId = id;
      return 'list';
    }
    this.listId = n.parent || 'white';
    this.leafId = id;
    this.index = 0;
    return 'game';
  }

  close() {
    this.leafId = null;
  }

  get leafGames() {
    return this.leafId ? this.gamesOf(this.leafId) : [];
  }

  get current() {
    return this.leafGames[this.index] ?? null;
  }

  get currentPgn() {
    return this.current ? this.pgns[this.current.game_id] : null;
  }

  step(delta) {
    const next = this.index + delta;
    if (next < 0 || next >= this.leafGames.length) return false;
    this.index = next;
    return true;
  }
}
