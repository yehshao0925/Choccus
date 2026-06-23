"""Python mirror of shared/protocol.ts — wire encoding for the relay.

shared/protocol.ts is the SINGLE SOURCE OF TRUTH for message-type ids and
field names; this module mirrors it by hand. Keep both in sync.

Wire format: ``[1-byte MsgType id][MessagePack payload]``. The ``type`` field
of each TS message interface is the discriminated-union tag and is carried by
the 1-byte header — it is NOT duplicated inside the msgpack payload.

Builders below return fully encoded ``bytes`` ready to send. ``decode``
returns ``(type_id, payload_dict)``.
"""

from enum import IntEnum
from typing import Any

import msgpack


class MsgType(IntEnum):
    """Mirror of shared/protocol.ts MsgType. C→S: 0x01–0x0F, S→C: 0x10–0x1F."""

    # Client → Server
    JOIN_ROOM = 0x01
    LEAVE_ROOM = 0x02
    READY_TOGGLE = 0x03
    INPUT_FRAME = 0x04
    HASH_REPORT = 0x05
    ADD_BOT = 0x06
    REMOVE_BOT = 0x07
    MATCH_RESULT = 0x08

    # Server → Client
    ROOM_STATE = 0x10
    MATCH_START = 0x11
    INPUT_BROADCAST = 0x12
    TICK_READY = 0x13
    STALL_NOTICE = 0x14
    HASH_MISMATCH = 0x15
    PLAYER_DISCONNECT = 0x16


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


def encode(type_id: int, payload: dict[str, Any] | None = None) -> bytes:
    """Frame a message: 1-byte type id + msgpack payload."""
    return bytes([type_id]) + msgpack.packb(payload or {}, use_bin_type=True)


def decode(data: bytes) -> tuple[int, dict[str, Any]]:
    """Split a frame into (type_id, payload dict). Raises on malformed data."""
    if len(data) < 1:
        raise ValueError("empty frame")
    payload = msgpack.unpackb(data[1:], raw=False)
    if not isinstance(payload, dict):
        raise ValueError(f"payload is not a map: {type(payload).__name__}")
    return data[0], payload


# ---------------------------------------------------------------------------
# Client → Server builders (used by tests / smoke client)
# ---------------------------------------------------------------------------


def join_room(room_id: str, name: str, player_id: str = "") -> bytes:
    """JoinRoomMsg — roomId '' means create a new room."""
    return encode(
        MsgType.JOIN_ROOM,
        {"roomId": room_id, "name": name, "playerId": player_id},
    )


def match_result(winner_team: int | None) -> bytes:
    """MatchResultMsg — winning team (= winning slot in FFA), or None for a draw."""
    return encode(MsgType.MATCH_RESULT, {"winnerTeam": winner_team})


def leave_room() -> bytes:
    return encode(MsgType.LEAVE_ROOM, {})


def ready_toggle(ready: bool) -> bytes:
    return encode(MsgType.READY_TOGGLE, {"ready": ready})


def add_bot(slot: int, difficulty: str = "normal") -> bytes:
    return encode(MsgType.ADD_BOT, {"slot": slot, "difficulty": difficulty})


def remove_bot(slot: int) -> bytes:
    return encode(MsgType.REMOVE_BOT, {"slot": slot})


def input_frame(t: int, dirs: int, actions: int) -> bytes:
    return encode(MsgType.INPUT_FRAME, {"t": t, "dirs": dirs, "actions": actions})


def hash_report(t: int, hash_: int) -> bytes:
    return encode(MsgType.HASH_REPORT, {"t": t, "hash": hash_})


# ---------------------------------------------------------------------------
# Server → Client builders
# ---------------------------------------------------------------------------


def room_state(
    room_id: str, phase: int, you_slot: int, players: list[dict[str, Any]]
) -> bytes:
    """RoomStateMsg — players: [{slot, name, ready, connected, isBot, botDifficulty, score}], youSlot per receiver."""
    return encode(
        MsgType.ROOM_STATE,
        {"roomId": room_id, "phase": phase, "youSlot": you_slot, "players": players},
    )


def match_start(seed: int, slot: int, config: dict[str, Any], t0: int) -> bytes:
    """MatchStartMsg — config is the frozen FeelParams dict (moveSpeed, …)."""
    return encode(
        MsgType.MATCH_START, {"seed": seed, "slot": slot, "config": config, "t0": t0}
    )


def input_broadcast(t: int, inputs: list[dict[str, int]]) -> bytes:
    """InputBroadcastMsg — inputs: [{dirs, actions}] indexed by slot."""
    return encode(MsgType.INPUT_BROADCAST, {"t": t, "inputs": inputs})


def tick_ready(t: int) -> bytes:
    return encode(MsgType.TICK_READY, {"t": t})


def stall_notice(t: int, waiting: list[int]) -> bytes:
    """StallNoticeMsg — waiting: slots the server is still waiting on."""
    return encode(MsgType.STALL_NOTICE, {"t": t, "waiting": waiting})


def hash_mismatch(t: int, hashes: list[int]) -> bytes:
    """HashMismatchMsg — hashes: uint32 per slot, indexed by slot (0 = no report)."""
    return encode(MsgType.HASH_MISMATCH, {"t": t, "hashes": hashes})


def player_disconnect(slot: int) -> bytes:
    return encode(MsgType.PLAYER_DISCONNECT, {"slot": slot})
