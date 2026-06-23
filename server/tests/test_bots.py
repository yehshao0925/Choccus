"""Bot-slot tests: roster, start rule, and lockstep exclusion (no sockets)."""

from relay.lobby import Lobby
from relay.protocol import MsgType, decode
from relay.tick_coordinator import TickCoordinator


def noop(_data: bytes) -> None:
    pass


def test_add_bot_occupies_slot_and_blocks_reuse():
    room = Lobby().create_room()
    assert room.add_player("alice", noop) == 0
    assert room.add_bot(1) is True
    # The bot slot is taken: the next human gets slot 2, not 1.
    assert room.add_player("bob", noop) == 2
    # A second bot can't reuse an occupied slot.
    assert room.add_bot(1) is False
    assert room.add_bot(0) is False  # human-held


def test_bot_appears_in_roster_with_isbot_flag_and_tier():
    captured: list[bytes] = []
    room = Lobby().create_room()
    room.add_player("alice", captured.append)
    room.add_bot(2, "hard")
    room.broadcast_room_state()
    type_id, payload = decode(captured[-1])
    assert type_id == MsgType.ROOM_STATE
    bot = next(p for p in payload["players"] if p["slot"] == 2)
    assert bot["isBot"] is True and bot["ready"] is True and bot["connected"] is True
    assert bot["botDifficulty"] == "hard"


def test_unknown_difficulty_falls_back_to_normal():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_bot(1, "impossible")
    assert room.bots[1] == "normal"


def test_can_start_counts_bots_but_not_as_blockers():
    room = Lobby().create_room()
    room.add_player("alice", noop)
    room.add_bot(1)
    assert not room.can_start()  # alice not ready
    room.set_ready(0, True)
    assert room.can_start()  # 1 human (ready) + 1 bot = 2 participants


def test_coordinator_never_waits_on_bot_slot():
    msgs: list[tuple[int, dict]] = []
    coord = TickCoordinator(
        slots=(0, 1), broadcast=lambda d: msgs.append(decode(d)), bots=(1,), first_tick=2
    )
    # Only the human slot 0 submits — the bot slot 1 is never required.
    coord.on_input(0, 2, dirs=5, actions=1)
    broadcasts = [p for t, p in msgs if t == MsgType.INPUT_BROADCAST]
    # Tick advances, and the array still spans slot 1 (neutral filler; the
    # client overrides it with locally-computed bot input).
    assert broadcasts == [
        {"t": 2, "inputs": [{"dirs": 5, "actions": 1}, {"dirs": 0, "actions": 0}]}
    ]
    assert coord.next_tick == 3
