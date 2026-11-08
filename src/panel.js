import { Chess } from '../vendor/chess.js';
import { MAX_RATING, MIN_RATING, RATING_STEP } from './bot-pick.js';
import { ENGINE_NAME } from './engine.js';
import { learnedCount } from './repertoire.js';
import { isWhiteMove, moveNumber, START_FEN } from './tree.js';

const icon = (paths, size = 24) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  back: '<path d="M20 12H5M11 6l-6 6 6 6"/>',
  forward: '<path d="M4 12h15M13 6l6 6-6 6"/>',
  analysis: '<circle cx="10.5" cy="10.5" r="7"/><path d="M15.8 15.8L21 21M10.5 7.5v6M7.5 10.5h6"/>',
  games: '<path d="M3 10h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 10l-.6-3.6 17-3 .6 3.6zM8 5l2 4M14 4l2 4"/>',
  play: '<rect x="4" y="7.5" width="16" height="12" rx="3"/><path d="M12 7.5v-3M9.5 15.5h5"/><circle cx="9" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="3.6" r="1.2" fill="currentColor" stroke="none"/>',
  explore: '<circle cx="12" cy="12" r="9.5"/><path d="M15.8 8.2l-2.2 5.4-5.4 2.2 2.2-5.4z"/>',
  dots: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  chevron: '<path d="M6 9.5l6 6 6-6" fill="currentColor" stroke-width="0"/><path d="M6 9.5h12l-6 6z" fill="currentColor" stroke-width="0"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 21H20v-3"/>',
  repertoire: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5zM4 20.5A2.5 2.5 0 0 0 6.5 21H20v-3"/>',
  first: '<path d="M6 5v14M19 5l-8 7 8 7z" fill="currentColor"/>',
  prev: '<path d="M15.5 5l-7 7 7 7" stroke-width="3"/>',
  next: '<path d="M8.5 5l7 7-7 7" stroke-width="3"/>',
  last: '<path d="M18 5v14M5 5l8 7-8 7z" fill="currentColor"/>',
  plus: '<circle cx="10.5" cy="10.5" r="7"/><path d="M15.8 15.8L21 21M10.5 7.5v6M7.5 10.5h6"/>',
  save: '<path d="M12 3v12M7 10.5l5 5 5-5M4 20.5h16"/>',
  share: '<circle cx="18" cy="5.5" r="2.7"/><circle cx="6" cy="12" r="2.7"/><circle cx="18" cy="18.5" r="2.7"/><path d="M8.4 10.7l7.2-3.9M8.4 13.3l7.2 3.9"/>',
};

const FIGURINES = {
  w: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞' },
  b: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' },
};

// Chess.com draws White's moves with solid figurines and Black's in outline.
function sanHtml(san, color) {
  const glyph = (p) => `<span class="fig">${FIGURINES[color][p]}︎</span>`;
  return san
    .replace(/^[KQRBN]/, (p) => glyph(p))
    .replace(/=([QRBN])/, (_, p) => `=${glyph(p)}`);
}

function formatScore(line) {
  if (line.mate != null) return `${line.mate > 0 ? '+' : '-'}M${Math.abs(line.mate)}`;
  const value = line.cp / 100;
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const formatPct = (x) => (x == null ? '' : `${Math.round(x * 100)}%`);
const formatDate = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

const ratingLabel = (r) => (r >= MAX_RATING ? 'Max' : String(r));
const clampRating = (r) => Math.max(MIN_RATING, Math.min(MAX_RATING, Number(r) || 1500));
const KING = (color) => `<img src="assets/pieces/${color}K.png" alt="">`;

const EXPLORER_DBS = { lichess: 'Lichess 2200+', masters: 'Masters' };
const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');
function formatCount(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString('en-US');
}
// White / draw / black shares as one bar, with the percentage written in each part wide enough to hold it.
function resultBar(w, d, b) {
  const total = w + d + b || 1;
  const part = (n, cls) => {
    const pct = (n / total) * 100;
    return pct > 0 ? `<i class="${cls}" style="width:${pct}%">${pct >= 14 ? `${Math.round(pct)}%` : ''}</i>` : '';
  };
  return `<span class="explore-bar" aria-label="White ${Math.round((w / total) * 100)}%, draw ${Math.round((d / total) * 100)}%, Black ${Math.round((b / total) * 100)}%">${part(w, 'bar-w')}${part(d, 'bar-d')}${part(b, 'bar-b')}</span>`;
}

const formatSeconds = (s) => (s >= 60 ? `${Math.floor(s / 60)}m` : `${s.toFixed(1)}s`);

export class Panel {
  constructor(el, actions) {
    this.el = el;
    this.actions = actions;
    this.state = actions.state;
    this.tab = 'games';
    this.playFrom = 'here'; // the Play tab starts from the position on the board when there is one
    this.report = actions.report;
    this.menu = null;
    this.expanded = new Set();
    this.loadError = '';

    el.innerHTML = `
      <header class="side-header">
        <button class="side-back" data-action="load" aria-label="Load a game">${icon(ICONS.back, 20)}</button>
        <div class="side-title">${icon(ICONS.analysis)}<h1>Analysis</h1></div>
      </header>
      <nav class="tabs">
        ${['analysis', 'repertoire', 'games', 'play', 'explore'].map((t) => `
          <button class="tab" data-tab="${t}">${icon(ICONS[t])}<span>${t[0].toUpperCase()}${t.slice(1)}</span></button>`).join('')}
      </nav>
      <div class="side-body" id="side-body"></div>
      <footer class="controls">
        <div class="controls-primary">
          ${['first', 'prev', 'next', 'last'].map((d) => `
            <button class="nav-btn" data-step="${d}" aria-label="${d} move">${icon(ICONS[d])}</button>`).join('')}
        </div>
        <div class="controls-secondary">
          <button class="ghost-btn" data-action="new">${icon(ICONS.plus, 20)}<span>New</span></button>
          <button class="ghost-btn" data-action="share">${icon(ICONS.share, 20)}<span>Share</span></button>
          <button class="ghost-btn" data-action="play-here" title="Play the computer from this position">${icon(ICONS.play, 20)}<span>Play bot</span></button>
          <button class="icon-btn" data-menu="more" aria-label="More">${icon(ICONS.dots, 20)}</button>
        </div>
      </footer>
      <div class="popover" id="popover" hidden></div>`;

    this.body = el.querySelector('#side-body');
    this.popover = el.querySelector('#popover');
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('change', (e) => this.onChange(e));
    el.addEventListener('input', (e) => {
      if (!e.target.matches('[data-play-rating]')) return;
      const value = clampRating(e.target.value);
      this.actions.setPref('botRating', value);
      this.body.querySelector('#play-rating').textContent = ratingLabel(value);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#popover, [data-menu]')) this.closeMenu();
    });
    this.renderBody();
  }

  onClick(e) {
    const hit = (sel) => e.target.closest(sel);
    let t;
    if ((t = hit('[data-report]'))) { this.openReport(t.dataset.report); }
    else if ((t = hit('[data-report-step]'))) { this.stepReport(Number(t.dataset.reportStep)); }
    else if ((t = hit('[data-tab]'))) { this.setTab(t.dataset.tab); }
    else if ((t = hit('[data-explore-db]'))) { this.actions.setPref('explorerDb', t.dataset.exploreDb); this.renderExplore(); }
    else if ((t = hit('[data-explore-move]'))) { this.actions.playSan(t.dataset.exploreMove); }
    else if ((t = hit('[data-play-from]'))) { this.playFrom = t.dataset.playFrom; this.renderPlay(); }
    else if ((t = hit('[data-play-color]'))) { this.actions.setPref('botColor', t.dataset.playColor); this.renderPlay(); }
    else if ((t = hit('[data-play-step]'))) {
      const rating = clampRating(this.state.settings.botRating) + Number(t.dataset.playStep) * RATING_STEP;
      this.actions.setPref('botRating', clampRating(rating));
      this.renderPlay();
    }
    else if ((t = hit('[data-study]'))) { this.openStudy(Number(t.dataset.study)); }
    else if ((t = hit('[data-practice]'))) { this.openPractice(Number(t.dataset.practice)); }
    else if ((t = hit('[data-step]'))) { this.stepTo(t.dataset.step); }
    else if ((t = hit('[data-node]'))) { this.actions.goTo(this.findNode(Number(t.dataset.node))); }
    else if ((t = hit('[data-line]'))) { this.playFromLine(Number(t.dataset.line), Number(t.dataset.ply)); }
    else if ((t = hit('[data-expand]'))) { this.toggleExpanded(Number(t.dataset.expand)); }
    else if ((t = hit('[data-menu]'))) { this.toggleMenu(t.dataset.menu); }
    else if ((t = hit('[data-action]'))) { this.runAction(t.dataset.action); }
  }

  // Leaving a drill stops it; the board keeps the position for analysis.
  // A finished game against the computer stays on the board for analysis once you leave the tab.
  setTab(tab) {
    if (this.state.practice && tab !== 'repertoire') this.actions.stopPractice();
    if ((this.state.play?.over || this.state.play?.failed) && tab !== 'play') this.actions.closePlay();
    this.tab = tab;
    this.renderBody();
  }

  openReport(id) {
    const opened = this.report.open(id);
    if (opened === 'list') this.renderBody();
    else if (opened === 'game') this.actions.openReportGame();
  }

  stepReport(delta) {
    if (this.report.step(delta)) this.actions.openReportGame();
  }

  repertoire() {
    const { repertoires, settings } = this.state;
    return repertoires.find((r) => r.id === settings.repertoire) ?? repertoires[0];
  }

  openStudy(index) {
    const repertoire = this.repertoire();
    this.actions.studyLine(repertoire, repertoire.lines[index]);
    this.setTab('analysis');
  }

  // No index means every line in the repertoire.
  openPractice(index) {
    const repertoire = this.repertoire();
    this.actions.startPractice(repertoire, Number.isNaN(index) ? repertoire.lines : [repertoire.lines[index]]);
    this.setTab('repertoire');
  }

  onChange(e) {
    if (e.target.matches('[data-repertoire]')) {
      this.actions.selectRepertoire(e.target.value);
      this.renderBody();
      return;
    }
    const { setting } = e.target.dataset;
    if (!setting) return;
    const value = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    this.actions.setSetting(setting, value);
  }

  runAction(name) {
    const a = this.actions;
    this.closeMenu();
    if (name === 'new') { a.newGame(); this.setTab('analysis'); }
    else if (name === 'load') { this.setTab('games'); }
    else if (name === 'practice-next') a.nextPractice();
    else if (name === 'practice-hint') a.showHint();
    else if (name === 'practice-stop') { a.stopPractice(); this.renderBody(); }
    else if (name === 'study-close') { a.closeStudy(); this.setTab('repertoire'); }
    else if (name === 'lesson-prev') a.lessonStep(-1);
    else if (name === 'lesson-next') a.lessonStep(1);
    else if (name === 'lesson-close') a.closeLesson();
    else if (name === 'save') a.downloadPgn();
    else if (name === 'share' || name === 'copy-pgn') a.copyPgn();
    else if (name === 'copy-fen') a.copyFen();
    else if (name === 'flip') a.flip();
    else if (name === 'explore') { this.setTab('explore'); }
    else if (name === 'submit-load') this.submitLoad();
    else if (name === 'play-start') a.startPlay(this.playFrom === 'here' && this.canPlayHere());
    else if (name === 'play-here') { this.playFrom = 'here'; this.setTab('play'); }
    else if (name === 'play-back') a.backToGame();
    else if (name === 'play-rematch') a.rematch();
    else if (name === 'play-takeback') a.takeback();
    else if (name === 'play-resign') a.resign();
    else if (name === 'play-new') a.newPlay();
    else if (name === 'play-analyze') { a.closePlay(); this.setTab('analysis'); }
  }

  submitLoad() {
    const text = this.body.querySelector('textarea').value;
    try {
      this.actions.loadText(text);
      this.loadError = '';
      this.tab = 'analysis';
      this.renderBody();
    } catch {
      this.loadError = 'That doesn\'t look like a valid PGN or FEN.';
      this.renderBody();
      this.body.querySelector('textarea').value = text;
    }
  }

  findNode(id) {
    const walk = (n) => {
      if (n.id === id) return n;
      for (const c of n.children) { const hit = walk(c); if (hit) return hit; }
      return null;
    };
    return walk(this.state.game.root);
  }

  playFromLine(index, ply) {
    const line = this.state.analysis.lines[index];
    if (line) this.actions.playLine(this.state.node, line.pv.slice(0, ply + 1));
  }

  toggleExpanded(index) {
    if (!this.expanded.delete(index)) this.expanded.add(index);
    this.renderEngine();
  }

  toggleMenu(name) {
    if (this.menu === name) { this.closeMenu(); return; }
    this.menu = name;
    const { settings } = this.state;
    const item = (action, label) => `<button class="menu-item" data-action="${action}">${label}</button>`;
    this.popover.className = `popover popover-${name}`;
    this.popover.innerHTML = name === 'settings'
      ? `<label class="menu-row">Lines
           <select data-setting="lines">${[1, 2, 3, 4, 5].map((n) => `<option ${n === settings.lines ? 'selected' : ''}>${n}</option>`).join('')}</select>
         </label>
         <label class="menu-row">Depth
           <select data-setting="depth">${[16, 20, 24, 30, 36].map((n) => `<option ${n === settings.depth ? 'selected' : ''}>${n}</option>`).join('')}</select>
         </label>
         <label class="menu-row">Best move arrow
           <input type="checkbox" data-setting="showArrow" ${settings.showArrow ? 'checked' : ''}>
         </label>
         <label class="menu-row">Think ahead
           <input type="checkbox" data-setting="thinkAhead" ${settings.thinkAhead ? 'checked' : ''}>
         </label>`
      : item('flip', 'Flip board') + item('copy-fen', 'Copy FEN') + item('copy-pgn', 'Copy PGN');
    this.popover.hidden = false;
  }

  closeMenu() {
    this.menu = null;
    this.popover.hidden = true;
  }

  renderBody() {
    this.el.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('tab-active', b.dataset.tab === this.tab));
    this.syncChrome();
    if (this.tab === 'play') {
      this.renderPlay();
    } else if (this.tab === 'explore') {
      this.renderExplore();
      this.renderNavState();
    } else if (this.tab === 'analysis') {
      this.body.innerHTML = `
        <div class="options" id="options"></div>
        <div class="engine-lines" id="engine-lines"></div>
        <div class="opening" id="opening"></div>
        <div id="study"></div>
        <div class="scroll" id="scroll"><div id="title"></div><div class="move-list" id="moves"></div></div>
        <div id="game-nav"></div>`;
      this.renderAnalysis();
      this.renderAll();
    } else if (this.tab === 'repertoire') {
      if (this.state.practice) this.renderPractice();
      else this.renderRepertoires();
    } else if (this.tab === 'games') {
      this.body.innerHTML = `
        <div class="scroll report" id="report"></div>
        <details class="load-wrap">
        <summary>Paste a PGN or FEN</summary>
        <div class="load">
          <label for="load-text">Paste a PGN or FEN</label>
          <textarea id="load-text" spellcheck="false" placeholder="1. e4 e5 2. Nf3 Nc6 ..."></textarea>
          ${this.loadError ? `<p class="load-error">${this.loadError}</p>` : ''}
          <button class="primary-btn" data-action="submit-load">Add Game</button>
        </div>
        </details>`;
      if (this.loadError) this.body.querySelector('.load-wrap').open = true;
      this.renderReport();
    } else {
      this.renderExplore();
    }
  }

  renderExplore() {
    const { explorer, node, play, settings } = this.state;
    const db = EXPLORER_DBS[settings.explorerDb] ? settings.explorerDb : 'lichess';
    const toggle = `
      <div class="report-side explore-side" role="group" aria-label="Database">
        ${Object.entries(EXPLORER_DBS).map(([id, label]) => `<button data-explore-db="${id}" aria-pressed="${id === db}">${label}</button>`).join('')}
      </div>`;
    const empty = (title, text = '') => `<div class="empty"><p>${title}</p>${text ? `<p>${text}</p>` : ''}</div>`;
    let content;
    if (play && !play.over) {
      content = empty('The explorer is off during your game.');
    } else if (!explorer || explorer === 'loading') {
      this.actions.loadExplorer();
      content = empty('Loading human games…');
    } else if (explorer === 'failed') {
      content = empty('The explorer data didn\'t load.', 'Reload the page to try again.');
    } else {
      const entry = explorer[db][positionKey(node.fen)];
      if (!entry) {
        content = empty(`No ${EXPLORER_DBS[db]} data for this position.`,
          'Positions from your games are included, up to the point where fewer than a handful of games reach them.');
      } else {
        const [w, d, b, moves] = entry;
        const total = w + d + b;
        const color = node.fen.split(' ')[1];
        content = total === 0 ? empty('No games reached this position.') : `
          <div class="explore-head"><span>Move</span><span class="num">Games</span><span></span><span>White / Draw / Black</span></div>
          ${moves.map(([san, mw, md, mb]) => `
            <button class="explore-row" data-explore-move="${escapeHtml(san)}">
              <span class="explore-move">${sanHtml(san, color)}</span>
              <span class="num">${formatCount(mw + md + mb)}</span>
              <span class="share">${formatPct((mw + md + mb) / total)}</span>
              ${resultBar(mw, md, mb)}
            </button>`).join('')}
          <div class="explore-row explore-total">
            <span class="explore-move">Σ</span>
            <span class="num">${formatCount(total)}</span>
            <span class="share"></span>
            ${resultBar(w, d, b)}
          </div>`;
      }
    }
    this.body.innerHTML = `
      <div class="opening" id="opening"></div>
      ${toggle}
      <div class="scroll explore">${content}</div>
      ${explorer?.meta ? `<p class="explore-source">${escapeHtml(explorer.meta[db])} · downloaded ${formatDate(explorer.meta.built)}</p>` : ''}`;
    this.renderOpening();
  }

  renderRepertoires() {
    const { repertoires } = this.state;
    if (repertoires.length === 0) {
      this.body.innerHTML = '<div class="empty"><p>No repertoires loaded.</p><p>Run tools/build-repertoires.py to create them.</p></div>';
      return;
    }
    const current = this.repertoire();
    const totals = current.lines.reduce((sum, line) => sum + line.sequences.length, 0);
    const learned = current.lines.reduce((sum, line) => sum + learnedCount(current, line), 0);
    this.body.innerHTML = `
      <div class="rep-head">
        <select class="rep-select" data-repertoire aria-label="Repertoire">
          ${repertoires.map((r) => `<option value="${r.id}" ${r === current ? 'selected' : ''}>${r.name}</option>`).join('')}
        </select>
        <p class="rep-text">${current.description}</p>
        <p class="rep-count">${learned} of ${totals} lines learned</p>
        <button class="primary-btn" data-practice="all">Practice all</button>
      </div>
      <div class="scroll rep-list">
        ${current.lines.map((line, i) => `
          <div class="rep-row">
            <div class="rep-name">
              <span>${line.name}</span>
              <em>${learnedCount(current, line)}/${line.sequences.length} learned</em>
            </div>
            <button class="small-btn" data-study="${i}">Study</button>
            <button class="small-btn" data-practice="${i}">Practice</button>
          </div>`).join('')}
      </div>`;
  }

  // The moves so far, as text. Black's reply stays on the board, not in a list to read ahead.
  renderPractice() {
    const { practice, game } = this.state;
    const { entry, ply, misses, done, wrong, hinted, arrow } = practice;
    const played = [];
    for (let n = game.root.children[0]; n; n = n.children[0]) played.push(n);
    const clean = misses === 0 && !hinted;
    let status = 'Play the repertoire move.';
    if (done) status = clean ? 'Line complete, no mistakes.' : 'Line complete. It will come back soon.';
    else if (wrong) status = arrow ? 'Not that one. Follow the arrow.' : 'Not the repertoire move. Try again.';
    else if (arrow) status = 'Follow the arrow.';
    this.body.innerHTML = `
      <div class="rep-head">
        <h2 class="rep-title">${entry.line.name}</h2>
        <p class="rep-status ${wrong ? 'rep-wrong' : ''} ${done && clean ? 'rep-right' : ''}">${status}</p>
        <div class="rep-bar"><i style="width:${(ply / entry.moves.length) * 100}%"></i></div>
        ${done
          ? '<button class="primary-btn" data-action="practice-next">Next line</button>'
          : '<button class="small-btn rep-wide" data-action="practice-hint">Hint</button>'}
      </div>
      <div class="scroll rep-moves">
        ${done ? `<p class="rep-text">${entry.line.note}</p>` : ''}
        <div>${played.map((n) => `${isWhiteMove(n) ? `<span class="sub-number">${moveNumber(n)}.</span>` : ''} ${sanHtml(n.san, isWhiteMove(n) ? 'w' : 'b')}`).join(' ')}</div>
      </div>
      <button class="small-btn rep-exit" data-action="practice-stop">End practice</button>`;
  }

  renderStudy() {
    const box = this.body.querySelector('#study');
    if (!box) return;
    const { study, lesson } = this.state;
    if (lesson) { this.renderLesson(box, lesson); return; }
    if (!study) { box.innerHTML = ''; return; }
    const lineIndex = study.repertoire.lines.indexOf(study.line);
    box.innerHTML = `
      <div class="study">
        <div class="study-head">
          <strong>${study.line.name}</strong>
          <span class="score ${study.line.eval >= 0 ? 'score-white' : 'score-black'}">${study.line.eval >= 0 ? '+' : ''}${study.line.eval.toFixed(2)}</span>
        </div>
        <p class="rep-text">${study.line.note}</p>
        <div class="study-actions">
          <button class="small-btn" data-practice="${lineIndex}">Practice this line</button>
          <button class="small-btn" data-action="study-close">All lines</button>
        </div>
      </div>`;
  }

  renderLesson(box, { lesson, step }) {
    const total = lesson.steps.length;
    box.innerHTML = `
      <div class="study">
        <div class="study-head"><strong></strong></div>
        <p class="lesson-text"></p>
        <div class="study-actions lesson-actions">
          <span class="lesson-count">Step ${step + 1} of ${total}</span>
          <button class="small-btn" data-action="lesson-prev" ${step === 0 ? 'disabled' : ''}>Back</button>
          <button class="small-btn" data-action="lesson-next" ${step === total - 1 ? 'disabled' : ''}>Next</button>
          <button class="small-btn" data-action="lesson-close">Close</button>
        </div>
      </div>`;
    box.querySelector('strong').textContent = lesson.title;
    box.querySelector('.lesson-text').textContent = lesson.steps[step].text;
  }

  renderAnalysis() {
    const opts = this.body.querySelector('#options');
    if (!opts) return;
    const { settings } = this.state;
    const depth = this.state.analysis.depth || 0;
    opts.innerHTML = `
      <div class="options-left">
        <label class="switch">
          <input type="checkbox" data-setting="engineOn" ${settings.engineOn ? 'checked' : ''}>
          <span class="switch-track"></span>
          <span>Analysis</span>
        </label>
        <button class="icon-btn" data-menu="more" aria-label="Options">${icon(ICONS.dots)}</button>
      </div>
      <div class="options-right">
        <span class="depth">depth=${depth} | ${ENGINE_NAME}</span>
        <button class="icon-btn" data-menu="settings" aria-label="Settings">${icon(ICONS.gear, 16)}</button>
      </div>`;
  }

  // The move buttons show in the Play tab only during a game, without New and Share.
  syncChrome() {
    const playing = this.tab === 'play' && !!this.state.play;
    this.el.querySelector('.controls').hidden = this.tab !== 'analysis' && this.tab !== 'explore' && !playing;
    this.el.querySelector('.controls-secondary').hidden = this.tab === 'play';
    const title = this.tab === 'play' ? 'Play Computer' : 'Analysis';
    const header = this.el.querySelector('.side-title');
    if (header.dataset.title !== title) {
      header.dataset.title = title;
      header.innerHTML = `${icon(this.tab === 'play' ? ICONS.play : ICONS.analysis)}<h1>${title}</h1>`;
    }
  }

  renderPlay() {
    this.syncChrome();
    const { play } = this.state;
    if (!play) { this.renderPlaySetup(); return; }
    let status = 'Your move';
    let tone = '';
    if (play.failed) {
      status = 'The computer couldn\'t start in this browser.';
      tone = 'play-bad';
    } else if (play.over) {
      const { winner, reason } = play.over;
      status = winner == null ? `Draw by ${reason}` : `${winner === play.color ? 'You won' : 'You lost'} by ${reason}`;
      tone = winner == null ? '' : winner === play.color ? 'play-good' : 'play-bad';
    } else if (play.thinking) {
      status = 'Computer is thinking…';
    } else if (this.state.node !== play.tip) {
      status = 'Go to the last move to play';
    }
    let yours = false;
    for (let n = play.tip; n !== play.start; n = n.parent) if ((isWhiteMove(n) ? 'w' : 'b') === play.color) yours = true;
    const actions = play.failed
      ? `<button class="primary-btn" data-action="play-rematch">Try again</button>
         <button class="small-btn" data-action="play-new">New game</button>`
      : play.over
        ? `<button class="primary-btn" data-action="play-rematch">${play.from ? 'Play this position again' : 'Rematch'}</button>
           <div class="play-row">
             <button class="small-btn" data-action="play-analyze">Analyze</button>
             ${play.source ? '<button class="small-btn" data-action="play-back">Back to game</button>' : ''}
             <button class="small-btn" data-action="play-new">New game</button>
           </div>`
        : `<div class="play-row">
             <button class="small-btn" data-action="play-takeback" ${yours ? '' : 'disabled'}>Takeback</button>
             <button class="small-btn ${play.confirmResign ? 'play-confirm' : ''}" data-action="play-resign">${play.confirmResign ? 'Confirm resign' : 'Resign'}</button>
           </div>`;
    this.body.innerHTML = `
      <div class="play-head">
        <div class="play-vs">Computer <span>(${ratingLabel(play.rating)})</span>${play.from ? `<em>from ${this.positionLabel(play.start)}</em>` : ''}</div>
        <p class="play-status ${tone}" role="status">${status}</p>
      </div>
      <div class="scroll" id="scroll"><div class="move-list" id="moves"></div></div>
      <div class="play-actions">${actions}</div>`;
    this.renderMoves();
    this.renderNavState();
  }

  // A position worth offering: not the plain starting position, and not already over.
  canPlayHere() {
    const { node } = this.state;
    return (!!node.parent || node.fen !== START_FEN) && !new Chess(node.fen).isGameOver();
  }

  // "move 15, White to move"
  positionLabel(node) {
    const [, side, , , , full] = node.fen.split(' ');
    return `move ${full}, ${side === 'w' ? 'White' : 'Black'} to move`;
  }

  renderPlaySetup() {
    const { settings } = this.state;
    const rating = clampRating(settings.botRating);
    const here = this.canPlayHere();
    const fromHere = here && this.playFrom === 'here';
    const from = here ? `
        <div class="play-label">Start from</div>
        <div class="play-from" role="group" aria-label="Start from">
          <button data-play-from="here" aria-pressed="${fromHere}"><span>This position</span><em>${this.positionLabel(this.state.node)}</em></button>
          <button data-play-from="start" aria-pressed="${!fromHere}"><span>Starting position</span><em>a new game</em></button>
        </div>` : '';
    const colors = [['w', 'White', KING('w')], ['random', 'Random', `<span class="play-random">${KING('w')}${KING('b')}</span>`], ['b', 'Black', KING('b')]];
    this.body.innerHTML = `
      <div class="play-setup">
        ${from}
        <div class="play-label" id="play-rating-label">Computer rating</div>
        <div class="play-picker">
          <button class="play-step" data-play-step="-1" aria-label="Lower rating" ${rating <= MIN_RATING ? 'disabled' : ''}>−</button>
          <output class="play-rating" id="play-rating" aria-live="polite">${ratingLabel(rating)}</output>
          <button class="play-step" data-play-step="1" aria-label="Higher rating" ${rating >= MAX_RATING ? 'disabled' : ''}>+</button>
        </div>
        <input class="play-slider" type="range" min="${MIN_RATING}" max="${MAX_RATING}" step="${RATING_STEP}" value="${rating}" data-play-rating aria-labelledby="play-rating-label">
        <div class="play-scale"><span>${MIN_RATING}</span><span>Max</span></div>
        <div class="play-label">I play as</div>
        <div class="play-colors" role="group" aria-label="I play as">
          ${colors.map(([c, label, img]) => `
            <button class="play-color" data-play-color="${c}" aria-pressed="${c === settings.botColor}">${img}<span>${label}</span></button>`).join('')}
        </div>
        <button class="primary-btn play-start" data-action="play-start">Play</button>
      </div>`;
  }

  renderAll() {
    if (this.tab === 'repertoire' && this.state.practice) this.renderPractice();
    if (this.tab === 'play') { this.renderPlay(); return; }
    if (this.tab === 'explore') { this.renderExplore(); this.renderNavState(); return; }
    if (this.tab !== 'analysis') return;
    this.renderTitle();
    this.renderMoves();
    this.renderOpening();
    this.renderStudy();
    this.renderEngine();
    this.renderNavState();
    this.renderGameNav();
  }

  renderReport() {
    const box = this.body.querySelector('#report');
    if (!box) return;
    const r = this.report;
    if (r.nodes.length === 0) { box.innerHTML = '<div class="empty"><p>Loading your games…</p></div>'; return; }
    const chain = r.path(r.listId);
    const crumbs = chain.length > 1
      ? `<nav class="report-crumbs" aria-label="Back">${chain.map((n, i) => (i === chain.length - 1
        ? `<span class="current">${escapeHtml(n.name)}</span><span class="count">(${n.games})</span>`
        : `<button data-report="${escapeHtml(n.id)}">${escapeHtml(n.name)}</button><span aria-hidden="true">›</span>`)).join('')}</nav>`
      : '';
    const rows = r.children(r.listId).map((n) => `
      <button class="report-row ${n.id === r.leafId ? 'is-open' : ''}" data-report="${escapeHtml(n.id)}">
        <span class="name">${escapeHtml(n.name)}</span>
        <span class="num">${n.games}</span>
        <span class="share">(${formatPct(r.share(n))})</span>
        <span class="num">${formatPct(n.score)}</span>
      </button>`).join('');
    box.innerHTML = `
      <div class="report-side" role="group" aria-label="Color">
        <button data-report="white" aria-pressed="true">White</button>
        <button disabled aria-pressed="false">Black</button>
      </div>
      ${crumbs}
      <div class="report-head"><span></span><span class="num">Games</span><span></span><span class="num">Score</span></div>
      ${rows}`;
  }

  renderGameNav() {
    const box = this.body.querySelector('#game-nav');
    if (!box) return;
    const r = this.report;
    const game = r.current;
    if (!game) { box.innerHTML = ''; return; }
    const total = r.leafGames.length;
    box.innerHTML = `
      <div class="game-nav">
        <button class="nav-btn" data-report-step="-1" aria-label="Previous game" ${r.index === 0 ? 'disabled' : ''}>${icon(ICONS.back)}</button>
        <div class="game-nav-label">
          <span class="game-nav-line">${escapeHtml(r.node(r.leafId)?.name ?? '')}</span>
          <span>Game ${r.index + 1} of ${total} · ${game.time_class === 'blitz' ? 'Blitz' : 'Rapid'} · ${formatDate(game.date)} · ${escapeHtml(game.result)}</span>
        </div>
        <button class="nav-btn" data-report-step="1" aria-label="Next game" ${r.index >= total - 1 ? 'disabled' : ''}>${icon(ICONS.forward)}</button>
      </div>`;
  }

  renderNavState() {
    const { node } = this.state;
    const set = (step, enabled) => { this.el.querySelector(`[data-step=${step}]`).disabled = !enabled; };
    set('first', !!node.parent);
    set('prev', !!node.parent);
    set('next', node.children.length > 0);
    set('last', node.children.length > 0);
  }

  renderEngine() {
    const box = this.body.querySelector('#engine-lines');
    if (!box) return;
    const { analysis, node, settings } = this.state;
    const depthEl = this.body.querySelector('.depth');
    if (depthEl) depthEl.textContent = `depth=${analysis.depth} | ${ENGINE_NAME}`;

    const chess = new Chess(node.fen);
    if (!settings.engineOn) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    if (this.state.play) { box.innerHTML = '<div class="game-over">Engine is off during your game</div>'; return; }

    if (chess.isGameOver()) {
      const label = chess.isCheckmate() ? 'Checkmate' : chess.isStalemate() ? 'Stalemate' : 'Draw';
      box.innerHTML = `<div class="game-over">${label}</div>`;
      return;
    }
    if (analysis.lines.length === 0) {
      box.innerHTML = Array.from({ length: settings.lines }, () =>
        '<div class="line line-loading"><span class="skeleton-score"></span><span class="skeleton-line"></span></div>').join('');
      return;
    }
    box.innerHTML = analysis.lines.map((line, i) => this.lineHtml(line, i, node.fen)).join('');
  }

  lineHtml(line, index, fen) {
    const chess = new Chess(fen);
    const white = line.mate != null ? line.mate > 0 : line.cp >= 0;
    const parts = [];
    line.pv.forEach((uci, ply) => {
      const color = chess.turn();
      const number = chess.moveNumber();
      let move;
      try {
        move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      } catch {
        return; // PV from a stale position; show what's legal
      }
      const prefix = color === 'w' ? `${number}. ` : ply === 0 ? `${number}... ` : '';
      parts.push(`<span class="line-move" data-line="${index}" data-ply="${ply}">${prefix}${sanHtml(move.san, color)}</span>`);
    });
    const open = this.expanded.has(index);
    return `
      <div class="line ${open ? 'line-open' : ''}">
        <span class="score ${white ? 'score-white' : 'score-black'}">${formatScore(line)}</span>
        <div class="line-moves">${parts.join(' ')}</div>
        <button class="line-more" data-expand="${index}" aria-label="Show more">${icon(ICONS.chevron, 16)}</button>
      </div>`;
  }

  renderOpening() {
    const box = this.body.querySelector('#opening');
    if (!box) return;
    let name = '';
    for (let n = this.state.node; n && !name; n = n.parent) {
      name = this.state.openings[n.fen.split(' ').slice(0, 4).join(' ')] ?? '';
    }
    box.innerHTML = `<span class="opening-name"></span>
      <button class="opening-book" data-action="explore" aria-label="Opening Explorer">${icon(ICONS.book, 20)}</button>`;
    box.querySelector('.opening-name').textContent = name || (this.state.node.parent ? '' : 'Starting Position');
  }

  renderTitle() {
    const box = this.body.querySelector('#title');
    const h = this.state.game.headers;
    if (!box) return;
    if (!h.White && !h.Black) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="game-title"><span></span></div>';
    const rating = (r) => (r && r !== '?' ? `(${r}) ` : '');
    const result = h.Result && h.Result !== '*' ? ` ${h.Result.replace('1/2-1/2', '½-½')}` : '';
    box.querySelector('span').textContent = `${rating(h.WhiteElo)}${h.White ?? '?'} - ${rating(h.BlackElo)}${h.Black ?? '?'}${result}`;
  }

  moveHtml(node) {
    const color = isWhiteMove(node) ? 'w' : 'b';
    const selected = node === this.state.node ? 'selected' : '';
    return `<span class="move ${selected}" data-node="${node.id}">${sanHtml(node.san, color)}</span>`;
  }

  // An inline run of moves for a variation: "11. h3 Bg7 12. Bd3 ...".
  sublineHtml(node, forceNumber = true) {
    const parts = [];
    for (let n = node, first = forceNumber; n; n = n.children[0], first = false) {
      const prefix = isWhiteMove(n) ? `${moveNumber(n)}.` : first ? `${moveNumber(n)}...` : '';
      if (prefix) parts.push(`<span class="sub-number">${prefix}</span>`);
      parts.push(this.moveHtml(n));
      for (const v of n.children.slice(1)) parts.push(`<div class="subline nested">${this.sublineHtml(v)}</div>`);
    }
    return parts.join(' ');
  }

  timeBars(white, black, scale) {
    const bar = (node, cls) => {
      if (node?.spent == null) return '';
      const width = Math.max(2, (node.spent / scale) * 100);
      return `<div class="time ${cls}"><em>${formatSeconds(node.spent)}</em><i style="width:${width}%"></i></div>`;
    };
    return `<div class="times">${bar(white, 'time-w')}${bar(black, 'time-b')}</div>`;
  }

  renderMoves() {
    const box = this.body.querySelector('#moves');
    if (!box) return;
    const { root } = this.state.game;

    const nodes = [];
    for (let n = root.children[0]; n; n = n.children[0]) nodes.push(n);
    const scale = Math.max(...nodes.map((n) => n.spent ?? 0), 1);

    let html = '';
    let rowIndex = 0;
    const placeholder = '<span class="ellipsis">...</span>';
    const row = (number, white, black, { split = false } = {}) => {
      const whiteCell = white ? this.moveHtml(white) : placeholder;
      const blackCell = black ? this.moveHtml(black) : split ? placeholder : '';
      html += `<div class="row ${rowIndex++ % 2 ? 'row-dark' : ''}">
        <span class="number">${number}.</span>
        <div class="cell">${whiteCell}</div>
        <div class="cell">${blackCell}</div>
        ${this.timeBars(white, black, scale)}
      </div>`;
    };
    const sublines = (list) => {
      for (const v of list) html += `<div class="subline">${this.sublineHtml(v)}</div>`;
    };

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const siblings = node.parent.children.slice(1);
      if (!isWhiteMove(node)) {
        row(moveNumber(node), null, node);
        sublines(siblings);
        continue;
      }
      const reply = nodes[i + 1];
      const replySiblings = reply ? reply.parent.children.slice(1) : [];
      if (siblings.length > 0 && reply) {
        // A variation splits the move pair across two rows, as "11. Bb5 ..." / "11. ... a6".
        row(moveNumber(node), node, null, { split: true });
        sublines(siblings);
        row(moveNumber(node), null, reply);
      } else {
        row(moveNumber(node), node, reply);
        sublines(siblings);
      }
      sublines(replySiblings);
      i += 1;
    }
    box.innerHTML = html;

    const selected = box.querySelector('.selected');
    const scroller = this.body.querySelector('#scroll');
    if (selected) {
      const a = selected.getBoundingClientRect();
      const b = scroller.getBoundingClientRect();
      if (a.top < b.top + 32) scroller.scrollTop -= b.top + 32 - a.top;
      else if (a.bottom > b.bottom - 32) scroller.scrollTop += a.bottom - b.bottom + 32;
    } else {
      scroller.scrollTop = this.state.node.parent ? scroller.scrollTop : 0;
    }
  }
}
