"""
Map generation — authored templates only, draws ZERO PRNG.
Ported from client/src/sim/Map.ts.
"""
import numpy as np
from rl.env.constants import MAP_COLS, MAP_ROWS
from rl.env.types import TILE_EMPTY, TILE_HARD, TILE_SOFT, TILE_PUSH

# Authored templates: '#'=HARD, 'S'=SOFT, 'P'=PUSH, '.'=EMPTY, '@'=spawn(EMPTY)
CLASSIC_TEMPLATE = [
    '@.SPSS...SSPS.@',
    '.#S#S#S#S#S#S#.',
    'SSSSSSSSSSSSSSS',
    'P#S#S#S#S#S#S#P',
    'SSSSSSSSSSSSSSS',
    '.#S#S#S#S#S#S#.',
    '..SSSSSSSSSSS..',
    '.#S#S#S#S#S#S#.',
    'SSSSSSSSSSSSSSS',
    'P#S#S#S#S#S#S#P',
    'SSSSSSSSSSSSSSS',
    '.#S#S#.#.#S#S#.',
    '@.SPSS...SSPS.@',
]

PIRATE_TEMPLATE = [
    'SSSS.@.S.@.SSSS',
    'S#S.PPP.PPP.S#S',
    'SS.P.S.P.S.P.SS',
    'S.P.SSSSSSS.P.S',
    'S.PSSSSSSSSSP.S',
    'S.P.SSSSSSS.P.S',
    'S.PSSS###SSSP.S',
    'SS.P.SSSSS.P.SS',
    'SSS.PSSSSSP.SSS',
    'SSSS.P.S.P.SSSS',
    'SS.SS.PPP.SS.SS',
    'S#.SSS...SSS.#S',
    'S@.SSSSSSSSS.@S',
]

VILLAGE_TEMPLATE = [
    '@.SSS...P.#S#@#',
    '.#PSP#P..#SS...',
    '..SSSS.PP.#P#P#',
    'P#P#P#P..#SSSSS',
    'SSSSSS..P.#P#P#',
    'S#S#S#PP..SSSSS',
    '#.#.#...P.#.#.#',
    'SSSSS.P..#S#S#S',
    '#P#PS#.PPSSSSSS',
    '#SSSSSP..#P#P#S',
    '#S#PS#P.PSSSSS.',
    '#@SSSS.P.#P#P#.',
    '######..P.SSS.@',
]

MAP_TEMPLATES: dict[str, list[str]] = {
    'classic': CLASSIC_TEMPLATE,
    'pirate':  PIRATE_TEMPLATE,
    'village': VILLAGE_TEMPLATE,
}
MAP_KINDS = list(MAP_TEMPLATES.keys())


def _template_tile(ch: str) -> int:
    """Map a single template char to its TileKind."""
    if ch == '#': return TILE_HARD
    if ch == 'S': return TILE_SOFT
    if ch == 'P': return TILE_PUSH
    return TILE_EMPTY  # '.' and '@'


def _spawns_of(tmpl: list[str]) -> list[tuple[int, int]]:
    """All '@' spawn tiles in a template, in scan order (y-major) = slot order."""
    out = []
    for y in range(MAP_ROWS):
        for x in range(MAP_COLS):
            if tmpl[y][x] == '@':
                out.append((x, y))
    return out


def _spawn_clear_set(spawns: list[tuple[int, int]]) -> set[int]:
    """
    The set of flat indices force-cleared to EMPTY around the spawns: each spawn
    tile plus its in-bounds, non-outer-ring orthogonal neighbours.
    """
    clear: set[int] = set()
    for (sx, sy) in spawns:
        clear.add(sy * MAP_COLS + sx)
        for (nx, ny) in [(sx+1, sy), (sx-1, sy), (sx, sy+1), (sx, sy-1)]:
            # Skip outer ring and out-of-bounds
            if 0 < nx < MAP_COLS - 1 and 0 < ny < MAP_ROWS - 1:
                clear.add(ny * MAP_COLS + nx)
    return clear


def generate_map(prng: int, kind: str = 'classic') -> tuple[np.ndarray, int]:
    """
    Generate grid from authored template. Draws ZERO PRNG (returns prng unchanged).

    Args:
        prng: PRNG state (passed through unchanged)
        kind: Map kind name (default: 'classic')

    Returns:
        (grid, prng_out) where grid is shape (MAP_ROWS * MAP_COLS,) uint8
    """
    tmpl = MAP_TEMPLATES.get(kind, CLASSIC_TEMPLATE)
    spawns = _spawns_of(tmpl)
    clear = _spawn_clear_set(spawns)
    grid = np.zeros(MAP_ROWS * MAP_COLS, dtype=np.uint8)
    for y in range(MAP_ROWS):
        for x in range(MAP_COLS):
            i = y * MAP_COLS + x
            grid[i] = TILE_EMPTY if i in clear else _template_tile(tmpl[y][x])
    return grid, prng  # prng unchanged


def map_spawns(kind: str) -> list[tuple[int, int]]:
    """
    Spawn positions for the given map kind, in slot order.

    Args:
        kind: Map kind name

    Returns:
        List of 4 (x, y) spawn tuples
    """
    tmpl = MAP_TEMPLATES.get(kind, CLASSIC_TEMPLATE)
    spawns = _spawns_of(tmpl)
    return spawns if spawns else [(1, 1), (MAP_COLS-2, 1), (1, MAP_ROWS-2), (MAP_COLS-2, MAP_ROWS-2)]
