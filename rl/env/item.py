# rl/env/item.py
"""ItemState + applyItem. Ported from client/src/sim/Item.ts."""
from rl.env.constants import (
    PLAYER_MAX_FIRE, PLAYER_MAX_CANNON, SPEED_BONUS_CAP, SPEED_BONUS_PER_ITEM
)
from rl.env.types import ITEM_FIRE, ITEM_SPEED, ITEM_CANNON


def apply_item(player: dict, kind: int) -> None:
    """Apply a picked-up item to the player. MUTATES player dict."""
    if kind == ITEM_FIRE:
        player['fire'] = min(player['fire'] + 1, PLAYER_MAX_FIRE)
    elif kind == ITEM_SPEED:
        # +1.0 tiles/s = +10 tenths; cap = 3.0 tiles/s = 30 tenths
        player['speed_bonus_tenths'] = min(
            player['speed_bonus_tenths'] + 10,
            round(SPEED_BONUS_CAP / SPEED_BONUS_PER_ITEM) * 10  # 30
        )
    elif kind == ITEM_CANNON:
        player['cannon'] = min(player['cannon'] + 1, PLAYER_MAX_CANNON)
