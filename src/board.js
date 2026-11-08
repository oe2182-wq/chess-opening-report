const FILES = 'abcdefgh';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_WIDTH = 2.75;
const HEAD_LENGTH = 4.5;
const HEAD_WIDTH = 7;

function parseFen(fen) {
  const pieces = new Map();
  fen.split(' ')[0].split('/').forEach((rank, r) => {
    let f = 0;
    for (const ch of rank) {
      if (/\d/.test(ch)) { f += Number(ch); continue; }
      const color = ch === ch.toUpperCase() ? 'w' : 'b';
      pieces.set(FILES[f] + (8 - r), color + ch.toUpperCase());
      f += 1;
    }
  });
  return pieces;
}

export class Board {
  // options: legalMoves(square) -> [{ to, promotion, capture }], onMove({ from, to, promotion })
  constructor(el, options) {
    this.el = el;
    this.options = options;
    this.orientation = 'w';
    this.pieceEls = new Map();
    this.fen = null;
    this.selected = null;
    this.dests = [];
    this.marks = new Set();
    this.userArrows = new Set();
    this.engineArrow = null;
    this.lessonArrows = []; // [{ from, to, color }]
    this.lastMove = null;

    el.innerHTML = `
      <svg class="coords" viewBox="0 0 100 100"></svg>
      <div class="layer" data-layer="marks"></div>
      <div class="layer" data-layer="hints"></div>
      <div class="layer" data-layer="pieces"></div>
      <svg class="arrows" viewBox="0 0 100 100"></svg>
      <div class="promotion" hidden></div>`;
    this.coordsEl = el.querySelector('.coords');
    this.marksEl = el.querySelector('[data-layer=marks]');
    this.hintsEl = el.querySelector('[data-layer=hints]');
    this.piecesEl = el.querySelector('[data-layer=pieces]');
    this.arrowsEl = el.querySelector('.arrows');
    this.promotionEl = el.querySelector('.promotion');

    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.renderCoords();
  }

  // Square <-> board percentage, respecting orientation.
  cell(square) {
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]) - 1;
    return this.orientation === 'w' ? { x: f, y: 7 - r } : { x: 7 - f, y: r };
  }

  squareAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = Math.floor(((clientX - rect.left) / rect.width) * 8);
    const y = Math.floor(((clientY - rect.top) / rect.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    return this.orientation === 'w' ? FILES[x] + (8 - y) : FILES[7 - x] + (y + 1);
  }

  place(el, square) {
    const { x, y } = this.cell(square);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  }

  setOrientation(color) {
    this.orientation = color;
    this.renderCoords();
    for (const [square, el] of this.pieceEls) this.place(el, square);
    this.renderMarks();
    this.renderArrows();
  }

  setPosition(fen, lastMove) {
    this.fen = fen;
    this.lastMove = lastMove;
    this.clearSelection();
    this.marks.clear();
    this.userArrows.clear();
    this.lessonArrows = [];
    this.promotionEl.hidden = true;
    this.syncPieces(parseFen(fen));
    this.renderMarks();
    this.renderArrows();
  }

  setEngineArrow(arrow) {
    this.engineArrow = arrow;
    this.renderArrows();
  }

  // Lesson drawings go away with the next position, like the user's own.
  setAnnotations({ arrows = [], marks = [] }) {
    this.lessonArrows = arrows.map(([from, to, color]) => ({ from, to, color }));
    this.marks = new Set(marks);
    this.renderMarks();
    this.renderArrows();
  }

  // Reuses piece elements so a move slides rather than blinks.
  syncPieces(next) {
    const previous = this.pieceEls;
    const kept = new Map();
    const added = [];
    for (const [square, piece] of next) {
      const el = previous.get(square);
      if (el && el.dataset.piece === piece) {
        kept.set(square, el);
        previous.delete(square);
      } else {
        added.push([square, piece]);
      }
    }
    for (const [square, piece] of added) {
      const from = [...previous].find(([, el]) => el.dataset.piece === piece);
      let el;
      if (from) {
        el = from[1];
        previous.delete(from[0]);
      } else {
        el = document.createElement('div');
        el.className = 'piece';
        el.dataset.piece = piece;
        el.style.backgroundImage = `url(assets/pieces/${piece}.png)`;
        el.classList.add('no-anim');
        this.piecesEl.append(el);
      }
      this.place(el, square);
      kept.set(square, el);
      requestAnimationFrame(() => el.classList.remove('no-anim'));
    }
    for (const el of previous.values()) el.remove();
    this.pieceEls = kept;
  }

  renderCoords() {
    const light = 'var(--board-light)';
    const dark = 'var(--board-dark)';
    const ranks = this.orientation === 'w' ? '87654321' : '12345678';
    const files = this.orientation === 'w' ? 'abcdefgh' : 'hgfedcba';
    let html = '';
    [...ranks].forEach((label, i) => {
      html += `<text x="0.75" y="${3.5 + i * 12.5}" fill="${i % 2 ? light : dark}">${label}</text>`;
    });
    [...files].forEach((label, i) => {
      html += `<text x="${10 + i * 12.5}" y="99" fill="${i % 2 ? dark : light}">${label}</text>`;
    });
    this.coordsEl.innerHTML = html;
  }

  renderMarks() {
    const squares = [];
    if (this.lastMove) squares.push([this.lastMove.from, 'mark-move'], [this.lastMove.to, 'mark-move']);
    if (this.selected) squares.push([this.selected, 'mark-move']);
    for (const s of this.marks) squares.push([s, 'mark-user']);
    this.marksEl.replaceChildren(...squares.map(([square, cls]) => {
      const el = document.createElement('div');
      el.className = `mark ${cls}`;
      this.place(el, square);
      return el;
    }));
  }

  renderHints() {
    this.hintsEl.replaceChildren(...this.dests.map((d) => {
      const el = document.createElement('div');
      el.className = `hint ${d.capture ? 'hint-capture' : ''}`;
      this.place(el, d.to);
      return el;
    }));
  }

  renderArrows() {
    const center = (square) => {
      const { x, y } = this.cell(square);
      return { x: x * 12.5 + 6.25, y: y * 12.5 + 6.25 };
    };
    const items = [...this.userArrows].map((key) => ({ from: key.slice(0, 2), to: key.slice(2), cls: 'arrow-user' }));
    if (this.engineArrow) items.push({ ...this.engineArrow, cls: 'arrow-engine' });
    for (const a of this.lessonArrows) items.push({ from: a.from, to: a.to, cls: `arrow-lesson-${a.color}` });

    this.arrowsEl.replaceChildren(...items.map(({ from, to, cls }) => {
      const a = center(from);
      const b = center(to);
      const dx = Math.abs(b.x - a.x);
      const dy = Math.abs(b.y - a.y);
      const isKnight = (dx === 12.5 && dy === 25) || (dx === 25 && dy === 12.5);
      const points = [a];
      if (isKnight) points.push(dy > dx ? { x: a.x, y: b.y } : { x: b.x, y: a.y });
      points.push(b);
      return this.arrowShape(points, cls);
    }));
  }

  arrowShape(points, cls) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', cls);
    const end = points[points.length - 1];
    const prev = points[points.length - 2];
    const len = Math.hypot(end.x - prev.x, end.y - prev.y);
    const ux = (end.x - prev.x) / len;
    const uy = (end.y - prev.y) / len;
    const tip = { x: end.x - ux * 2, y: end.y - uy * 2 };
    const base = { x: tip.x - ux * HEAD_LENGTH, y: tip.y - uy * HEAD_LENGTH };

    const start = points[0];
    const next = points[1];
    const startLen = Math.hypot(next.x - start.x, next.y - start.y);
    const offset = 3.5;
    const first = {
      x: start.x + ((next.x - start.x) / startLen) * offset,
      y: start.y + ((next.y - start.y) / startLen) * offset,
    };
    const shaft = document.createElementNS(SVG_NS, 'path');
    const mid = points.slice(1, -1).map((p) => `L${p.x} ${p.y}`).join(' ');
    shaft.setAttribute('d', `M${first.x} ${first.y} ${mid} L${base.x} ${base.y}`);
    shaft.setAttribute('stroke-width', ARROW_WIDTH);

    const head = document.createElementNS(SVG_NS, 'polygon');
    const px = -uy * (HEAD_WIDTH / 2);
    const py = ux * (HEAD_WIDTH / 2);
    head.setAttribute('points', `${tip.x},${tip.y} ${base.x + px},${base.y + py} ${base.x - px},${base.y - py}`);
    g.append(shaft, head);
    return g;
  }

  clearSelection() {
    this.selected = null;
    this.dests = [];
    this.hintsEl.replaceChildren();
    this.renderMarks();
  }

  select(square) {
    this.selected = square;
    this.dests = this.options.legalMoves(square);
    this.renderHints();
    this.renderMarks();
  }

  tryMove(from, to) {
    const candidates = this.options.legalMoves(from).filter((m) => m.to === to);
    if (candidates.length === 0) return false;
    if (candidates[0].promotion) {
      this.askPromotion(from, to);
    } else {
      this.options.onMove({ from, to });
    }
    return true;
  }

  askPromotion(from, to) {
    const color = to[1] === '8' ? 'w' : 'b';
    const { x, y } = this.cell(to);
    const fromTop = y === 0;
    this.promotionEl.style.left = `${x * 12.5}%`;
    this.promotionEl.style.top = fromTop ? '0' : 'auto';
    this.promotionEl.style.bottom = fromTop ? 'auto' : '0';
    this.promotionEl.style.flexDirection = fromTop ? 'column' : 'column-reverse';
    this.promotionEl.replaceChildren(...['Q', 'N', 'R', 'B'].map((p) => {
      const btn = document.createElement('button');
      btn.style.backgroundImage = `url(assets/pieces/${color}${p}.png)`;
      btn.setAttribute('aria-label', `Promote to ${p}`);
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.promotionEl.hidden = true;
        this.options.onMove({ from, to, promotion: p.toLowerCase() });
      });
      return btn;
    }));
    this.promotionEl.hidden = false;
  }

  onPointerDown(e) {
    const square = this.squareAt(e.clientX, e.clientY);
    if (!square) return;

    if (e.button === 2) {
      this.draw = { from: square };
      return;
    }
    if (e.button !== 0) return;
    if (!this.promotionEl.hidden) { this.promotionEl.hidden = true; return; }

    if (this.marks.size || this.userArrows.size) {
      this.marks.clear();
      this.userArrows.clear();
      this.renderMarks();
      this.renderArrows();
    }

    if (this.selected && this.selected !== square && this.tryMove(this.selected, square)) {
      this.clearSelection();
      return;
    }

    const el = this.pieceEls.get(square);
    const turn = this.fen.split(' ')[1];
    if (el && el.dataset.piece[0] === turn) {
      const wasSelected = this.selected === square;
      this.select(square);
      this.drag = { square, el, wasSelected, moved: false };
      e.preventDefault();
    } else {
      this.clearSelection();
    }
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const { el } = this.drag;
    const rect = this.el.getBoundingClientRect();
    const size = rect.width / 8;
    this.drag.moved = true;
    el.classList.add('dragging');
    el.style.transform = `translate(${e.clientX - rect.left - size / 2}px, ${e.clientY - rect.top - size / 2}px)`;
  }

  onPointerUp(e) {
    if (this.draw) {
      const to = this.squareAt(e.clientX, e.clientY);
      const { from } = this.draw;
      this.draw = null;
      if (!to) return;
      if (to === from) {
        if (!this.marks.delete(to)) this.marks.add(to);
        this.renderMarks();
      } else {
        const key = from + to;
        if (!this.userArrows.delete(key)) this.userArrows.add(key);
        this.renderArrows();
      }
      return;
    }

    if (!this.drag) return;
    const { square, el, wasSelected, moved } = this.drag;
    this.drag = null;
    el.classList.remove('dragging');
    const target = this.squareAt(e.clientX, e.clientY);

    if (moved && target && target !== square) {
      el.classList.add('no-anim');
      this.place(el, square);
      this.tryMove(square, target);
      this.clearSelection();
      requestAnimationFrame(() => el.classList.remove('no-anim'));
      return;
    }
    this.place(el, square);
    if (wasSelected && !moved) this.clearSelection();
  }
}
