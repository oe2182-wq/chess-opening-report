"""Downloads what humans played in the positions of your games, from the Lichess opening explorer,
into assets/explorer.json for the Explore tab. The published page can't call Lichess itself.

Two databases: Lichess games between players rated 2200+ (blitz, rapid and classical) and the
Masters database (over-the-board games, 2200+ FIDE). Positions come from your games in
assets/report/pgns.json and the repertoire lines, walked move by move from the start; a game stops
being followed once fewer than MIN_LICHESS games (and MIN_MASTERS master games) reach the position,
since the explorer has little to say past that point.

Needs a Lichess API token (no permissions) in ~/ChessAI/.lichess-token. Responses are cached in
data/explorer-cache.jsonl, so a run can stop and resume.

    python3 tools/fetch_explorer.py
"""
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import chess
import chess.pgn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.expanduser('~/ChessAI/.lichess-token')
CACHE = os.path.join(ROOT, 'data/explorer-cache.jsonl')
OUT = os.path.join(ROOT, 'assets/explorer.json')
UA = 'ChessAI-personal-analysis/0.1'
MAX_PLY = 40
MIN_LICHESS = 10
MIN_MASTERS = 5
TOP_MOVES = 12
DBS = {
    'lichess': 'https://explorer.lichess.ovh/lichess?variant=standard&speeds=blitz,rapid,classical&ratings=2200,2500'
               f'&moves={TOP_MOVES}&topGames=0&recentGames=0&fen=',
    'masters': f'https://explorer.lichess.ovh/masters?moves={TOP_MOVES}&topGames=0&fen=',
}


def key_of(board):
    return ' '.join(board.fen().split()[:4])


def load_paths():
    """Every position on the way through your games and repertoire lines: key -> (fen, ply, {san: child key})."""
    positions = {}

    def walk(board, sans):
        board = board.copy()
        for ply, san in enumerate(sans):
            if ply >= MAX_PLY:
                return
            k = key_of(board)
            entry = positions.setdefault(k, {'fen': board.fen(), 'ply': ply, 'children': {}})
            entry['ply'] = min(entry['ply'], ply)
            move = board.parse_san(san)
            board.push(move)
            entry['children'][san] = key_of(board)
        k = key_of(board)
        positions.setdefault(k, {'fen': board.fen(), 'ply': min(len(sans), MAX_PLY), 'children': {}})

    for pgn in json.load(open(os.path.join(ROOT, 'assets/report/pgns.json'))).values():
        game = chess.pgn.read_game(io.StringIO(pgn))
        board, sans = game.board(), []
        for move in game.mainline_moves():
            sans.append(board.san(move))
            board.push(move)
        walk(game.board(), sans)
    for rep in json.load(open(os.path.join(ROOT, 'assets/repertoires.json'))):
        for line in rep['lines']:
            for seq in line['sequences']:
                walk(chess.Board(), seq)
    return positions


def load_cache():
    cache = {}
    if os.path.exists(CACHE):
        for line in open(CACHE):
            row = json.loads(line)
            cache[(row['db'], row['key'])] = row['data']
    return cache


def fetch(db, fen, token):
    url = DBS[db] + urllib.parse.quote(fen)
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'User-Agent': UA})
    while True:
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print('rate limited, waiting a minute', file=sys.stderr, flush=True)
                time.sleep(61)
                continue
            if e.code in (401, 403):
                sys.exit(f'Lichess refused the token ({e.code}). Check ~/ChessAI/.lichess-token.')
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            print(f'network error ({e}), retrying in 10s', file=sys.stderr, flush=True)
            time.sleep(10)


def compact(data):
    """[white, draws, black, [[san, white, draws, black], ...]]"""
    moves = [[m['san'], m['white'], m['draws'], m['black']] for m in data.get('moves', [])]
    return [data.get('white', 0), data.get('draws', 0), data.get('black', 0), moves]


def write_out(results, positions):
    out = {'lichess': {}, 'masters': {}}
    for (db, k), data in results.items():
        out[db][k] = compact(data)
    out['meta'] = {
        'built': time.strftime('%Y-%m-%d'),
        'lichess': 'Lichess games, both players 2200+, blitz/rapid/classical',
        'masters': 'Masters (over-the-board, 2200+ FIDE)',
        'positions': len(positions),
    }
    tmp = OUT + '.tmp'
    json.dump(out, open(tmp, 'w'), separators=(',', ':'), ensure_ascii=False)
    os.replace(tmp, OUT)


def main():
    token = os.environ.get('LICHESS_TOKEN') or open(TOKEN_FILE).read().strip()
    positions = load_paths()
    cache = load_cache()
    cache_file = open(CACHE, 'a')
    results = {}
    start = chess.Board()
    frontier = {key_of(start): {'lichess', 'masters'}}  # key -> databases worth asking
    fetched = 0
    began = time.time()
    for ply in range(MAX_PLY + 1):
        if not frontier:
            break
        nxt = {}
        for k, dbs in frontier.items():
            entry = positions.get(k)
            if not entry:
                continue
            counts = {}
            for db in sorted(dbs):
                data = cache.get((db, k))
                if data is None:
                    data = fetch(db, entry['fen'], token)
                    cache[(db, k)] = data
                    cache_file.write(json.dumps({'db': db, 'key': k, 'data': data}) + '\n')
                    cache_file.flush()
                    fetched += 1
                    if fetched % 200 == 0:
                        write_out(results, positions)
                        rate = fetched / (time.time() - began)
                        print(f'{fetched} fetched ({rate:.1f}/s), ply {ply}, {len(results)} stored', file=sys.stderr, flush=True)
                results[(db, k)] = data
                counts[db] = {m['san']: m['white'] + m['draws'] + m['black'] for m in data.get('moves', [])}
            for san, child in entry['children'].items():
                want = set()
                if counts.get('lichess', {}).get(san, 0) >= MIN_LICHESS:
                    want.add('lichess')
                if counts.get('masters', {}).get(san, 0) >= MIN_MASTERS:
                    want.add('masters')
                if want:
                    nxt.setdefault(child, set()).update(want)
        frontier = {k: v - {db for db in v if (db, k) in results} for k, v in nxt.items()}
        frontier = {k: v for k, v in frontier.items() if v}
        print(f'ply {ply} done: {len(results)} stored, next ply {len(frontier)} positions', file=sys.stderr, flush=True)
    write_out(results, positions)
    sizes = {db: sum(1 for d, _ in results if d == db) for db in DBS}
    print(f'done: {sizes}, {fetched} new requests, {os.path.getsize(OUT) // 1024} KB')


if __name__ == '__main__':
    main()
