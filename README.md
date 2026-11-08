# Opening Report

Your rapid games as White, plus blitz games as White played at 2000+, grouped by opening, variation and line, with a chess.com-style
analysis board (Stockfish 19 Lite, drag and click moves, arrows) for each game.

Runs as a static page: `python3 -m http.server 5174`, then open http://localhost:5174. The piece images
aren't in this repository; see `assets/pieces/README.md`.

- `assets/report/` — the opening tree, games and PGNs, built by `python3 tools/build_report.py` from the
  chess.com archives in `data/archives/` (refresh a month with the chess.com public API, then rebuild).
- `src/report.js` — the opening tree and game stepping; `src/panel.js` draws it in the Games tab.
- Play tab — a game against the computer at a rating you pick (250 up to 3150, or Max). From 1320 up it's
  Stockfish's own strength limit (`UCI_Elo`); below 1320 the computer scores every legal move with a shallow
  search and picks one at random, weighted by how much it loses (`src/bot-pick.js`). Those weights were set by
  playing thousands of games against Stockfish's 1320 setting: `node tools/calibrate_bot.mjs`. The analysis
  engine is off until the game ends; Analyze then opens the game on the analysis board.
  Play bot (under the analysis board) starts a game from the position on the board, keeping the moves
  that led there; from a report game, Back to game returns to it afterwards.

Third-party code: Stockfish 19 Lite, built by stockfish.js (GPL-3.0, `vendor/stockfish/Copying.txt`; source at
https://github.com/nmrugg/stockfish.js and https://github.com/official-stockfish/Stockfish), chess.js
(BSD-2-Clause, `vendor/chess.js.LICENSE`). Opening names: `assets/openings.json`, from lichess-org/chess-openings (CC0).
