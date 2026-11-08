"""Builds assets/report/{nodes,games,pgns}.json from the chess.com archives in data/archives.

Games: every rapid game as White, plus blitz games as White played at a blitz rating of 2000 or more,
all in one tree. Openings are grouped by the position on the board, not chess.com's opening name.

    python3 tools/build_report.py
"""
import datetime
import glob
import io
import json
import os
from collections import defaultdict

import chess
import chess.pgn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ME = '0sama_0zzy'
BLITZ_FLOOR = 2000
DRAWS = {'agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'}

OPENINGS = [  # first Black move(s) -> id, name, moves
    ('c5', 'sicilian', 'Sicilian Defense', '1.e4 c5'),
    ('e5', 'e5', 'Open Game (1...e5)', '1.e4 e5'),
    ('c6', 'caro', 'Caro-Kann Defense', '1.e4 c6'),
    ('e6', 'french', 'French Defense', '1.e4 e6'),
    ('d6 g6', 'pirc', 'Pirc / Modern Defense', '1.e4 d6 or 1...g6'),
    ('d5', 'scandi', 'Scandinavian Defense', '1.e4 d5'),
    ('*', 'rare', 'Rare replies', '1...Nc6, 1...Nf6, 1...b6, 1...f5, 1...a6'),
]

SICILIANS = [  # id, name
    ('najdorf', 'Najdorf'), ('accel', 'Accelerated Dragon'), ('dragon', 'Dragon'), ('sveshnikov', 'Sveshnikov'),
    ('kalashnikov', 'Kalashnikov / Löwenthal'), ('classical', 'Classical'), ('scheveningen', 'Scheveningen'),
    ('taimanov', 'Taimanov'), ('kan', 'Kan'), ('fourknights', 'Four Knights'), ('marshall', 'Marshall Counterattack'),
    ('nc6-a6', '2…Nc6 and 4…a6'), ('other', 'Other Sicilians (…Qb6, 2…a6, no 3.d4)'),
]


# 1.e4 c5 2.Nf3 Nc6 3.d4 cxd4 4.Nxd4 a6, reached by any move order. Grouped on its own, ahead of the
# variations below, so it isn't split by Black's 5th move (5...e6 would count as a Taimanov, 5...d6 a Najdorf).
NC6_A6 = chess.Board()
for _m in 'e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 a6'.split():
    NC6_A6.push_san(_m)
NC6_A6 = NC6_A6.board_fen()


def sicilian(san):
    """Variation id for a Sicilian, from the position after Black's 5th move."""
    if len(san) >= 8:
        b = chess.Board()
        for m in san[:8]:
            b.push_san(m)
        if b.board_fen() == NC6_A6:
            return 'nc6-a6'
    if san[3:5] == ['e6', 'd4'] and san[5:6] == ['d5']:
        return 'marshall'
    if len(san) < 10 or san[6] != 'Nxd4':
        return 'other'
    b = chess.Board()
    for m in san[:10]:
        b.push_san(m)
    pawn = lambda sq: b.piece_at(chess.parse_square(sq)) == chess.Piece(chess.PAWN, chess.BLACK)
    knight = lambda sq: b.piece_at(chess.parse_square(sq)) == chess.Piece(chess.KNIGHT, chess.BLACK)
    if pawn('e5') and knight('c6'):
        return 'sveshnikov' if knight('f6') else 'kalashnikov'
    if pawn('a6') and pawn('d6'):
        return 'najdorf'
    if pawn('g6'):
        return 'dragon' if pawn('d6') else 'accel'
    if pawn('d6') and pawn('e6'):
        return 'scheveningen'
    if pawn('d6') and knight('c6'):
        return 'classical'
    if pawn('e6') and pawn('a6') and not knight('c6'):
        return 'kan'
    if pawn('e6') and knight('c6'):
        return 'fourknights' if knight('f6') else 'taimanov'
    return 'other'


def other_variation(opening, san):
    """(id, name) of the variation for the openings other than the Sicilian."""
    s = san + [''] * 16
    if opening == 'e5':
        if s[2:7] == ['Nf3', 'Nc6', 'd4', 'exd4', 'Nxd4']:
            names = {'Bc5': 'Scotch: Classical 4…Bc5', 'Nf6': 'Scotch: 4…Nf6', 'Qh4': 'Scotch: Steinitz 4…Qh4'}
            return f'scotch-{s[7].lower() or "x"}', names.get(s[7], f'Scotch: 4…{s[7]}' if s[7] else 'Scotch, other')
        if s[3] == 'Nf6':
            return 'petrov', 'Petrov 2…Nf6'
        if s[3] == 'd6':
            return 'philidor', 'Philidor 2…d6'
        return 'other', 'Other (no 3…exd4, Latvian, Elephant…)'
    if opening == 'caro':
        if 'exd5' in s[:8] and 'cxd5' in s[:8]:
            return ('panov', 'Exchange + early c4 (Panov-type)') if 'c4' in s[0:14:2] else ('exchange', 'Exchange, no early c4')
        return 'other', 'Other'
    if opening == 'french':
        return ('exchange', 'Exchange') if s[:7].count('exd5') == 2 else ('other', 'Other (…a6, …b6, …Ne7, 3.Nc3 …)')
    if opening == 'scandi':
        reply = s[3] if s[2] == 'exd5' else ''
        return {'Qxd5': ('qxd5', '2…Qxd5'), 'Nf6': ('nf6', '2…Nf6 (Modern)')}.get(reply, ('other', 'Other'))
    if opening == 'pirc':
        return ('d6', '1…d6 (Pirc etc.)') if s[1] == 'd6' else ('g6', '1…g6 (Modern)')
    named = {'Nc6': ('nc6', 'Nimzowitsch 1…Nc6'), 'Nf6': ('nf6', 'Alekhine 1…Nf6')}
    return named.get(s[1], (s[1].lower(), f'1…{s[1]}'))


def sicilian_line(var, san):
    """(id, name) of the line inside a Sicilian variation, or None when the variation isn't split."""
    s = san + [''] * 20
    w, b = s[0:14:2], s[1:14:2]
    if var == 'najdorf':
        if not s[10]:
            return 'short', 'Short games'
        if s[10] == 'Be3':
            if s[11] in ('e5', 'e6'):
                return f'be3-{s[11]}', f'6.Be3 {s[11]} (English Attack)'
            return 'be3-other', '6.Be3, other replies'
        return s[10].lower(), f'6.{s[10]}'
    if var == 'accel':
        if 'c4' in w:
            return 'maroczy', 'Maróczy Bind (c4)'
        if 'a6' in b and ('Nf6' not in b or b.index('a6') < b.index('Nf6')):
            return 'early-a6', 'Early …a6 before …Nf6'
        if 'f3' in w:
            return 'be3-f3', 'Be3 + f3 setup'
        return 'be3-other', 'Be3 with Bc4, Be2 or Qd2'
    if var == 'dragon':
        if 'f3' in w:
            return 'yugoslav', 'Yugoslav setup (Be3 + f3)'
        if 'Bg5' in w:
            return 'bg5', '6.Bg5'
        return 'other', 'Be3 without f3'
    if var == 'sveshnikov':
        if 'Ndb5' in w:
            return 'ndb5', 'Main line (6.Ndb5)'
        if 'Nb3' in w:
            return 'nb3', 'Knight back to b3'
        return 'nf3', 'Knight back to f3'
    if var == 'kalashnikov':
        if s[8] == 'Nb5' and s[9] == 'a6':
            return 'lowenthal', 'Löwenthal (5…a6)'
        if s[8] == 'Nb5':
            return 'kalashnikov', 'Kalashnikov (5…d6)'
        return 'nf3', 'Knight back to f3'
    return None


def main():
    games = [g for f in sorted(glob.glob(os.path.join(ROOT, 'data/archives/*.json'))) for g in json.load(open(f))['games']]
    nodes, rows, pgns = {}, [], {}
    members = defaultdict(list)

    def node(id, parent, name, order):
        nodes.setdefault(id, {'id': id, 'parent': parent, 'name': name, 'order': order})

    node('white', '', 'White', 0)
    for g in games:
        if g.get('rules') != 'chess' or g['white']['username'].lower() != ME:
            continue
        tc = g['time_class']
        if not (tc == 'rapid' or (tc == 'blitz' and g['white']['rating'] >= BLITZ_FLOOR)):
            continue
        pg = chess.pgn.read_game(io.StringIO(g['pgn']))
        board, san = pg.board(), []
        for m in list(pg.mainline_moves())[:20]:
            san.append(board.san(m))
            board.push(m)
        if len(san) < 2:
            continue
        order, (first, oid, oname, _) = next((i, o) for i, o in enumerate(OPENINGS) if san[1] in o[0].split() or o[0] == '*')
        path = [f'white.{oid}']
        node(path[0], 'white', oname, order)
        if oid == 'sicilian':
            vid = sicilian(san)
            path.append(f'{path[0]}.{vid}')
            node(path[-1], path[0], dict(SICILIANS)[vid], [s[0] for s in SICILIANS].index(vid))
            line = sicilian_line(vid, san)
            if line:
                path.append(f'{path[-1]}.{line[0]}')
                node(path[-1], path[-2], line[1], 0)
                if vid == 'najdorf' and line[0] == 'be3-e5':  # split by an early ...h5 (Black's first 10 moves)
                    sub = ('h5', 'h5 line', 0) if 'h5' in san[1:20:2] else ('other', 'Other lines', 1)
                    path.append(f'{path[-1]}.{sub[0]}')
                    node(path[-1], path[-2], sub[1], sub[2])
        else:
            vid, vname = other_variation(oid, san)
            path.append(f'{path[0]}.{vid}')
            node(path[-1], path[0], vname, 0)
        r = g['white']['result']
        result = 'Win' if r == 'win' else 'Draw' if r in DRAWS else 'Loss'
        gid = g['url'].rsplit('/', 1)[1]
        day = datetime.datetime.fromtimestamp(g['end_time']).date().isoformat()
        row = {'game_id': gid, 'node': path[-1], 'end': g['end_time'], 'date': day, 'time_class': tc, 'result': result,
               'opp_rating': g['black']['rating'], 'my_rating': g['white']['rating'], 'url': g['url']}
        rows.append(row)
        pgns[gid] = g['pgn']
        for p in ['white'] + path:
            members[p].append(row)

    # An opening whose games all fall in one variation doesn't need that level.
    for n in list(nodes.values()):
        kids = [k for k in nodes.values() if k['parent'] == n['id']]
        if len(kids) == 1 and not any(c['parent'] == kids[0]['id'] for c in nodes.values()):
            for row in members[kids[0]['id']]:
                row['node'] = n['id']
            del nodes[kids[0]['id']]

    points = {'Win': 1, 'Draw': .5, 'Loss': 0}
    for n in nodes.values():
        rs = members[n['id']]
        n['games'] = len(rs)
        n['score'] = round(sum(points[r['result']] for r in rs) / len(rs), 3)
        n['children'] = sum(1 for k in nodes.values() if k['parent'] == n['id'])

    rows.sort(key=lambda r: r['end'], reverse=True)
    out = os.path.join(ROOT, 'assets/report')
    json.dump(list(nodes.values()), open(os.path.join(out, 'nodes.json'), 'w'), ensure_ascii=False)
    json.dump(rows, open(os.path.join(out, 'games.json'), 'w'))
    json.dump(pgns, open(os.path.join(out, 'pgns.json'), 'w'))
    by_tc = defaultdict(int)
    for r in rows:
        by_tc[r['time_class']] += 1
    print(f"{len(rows)} games ({dict(by_tc)}), {len(nodes)} groups")


if __name__ == '__main__':
    main()
