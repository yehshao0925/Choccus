"""Encode/decode roundtrips for every message type in shared/protocol.ts."""

import pytest

from relay import protocol
from relay.protocol import MsgType, decode, encode


def roundtrip(data: bytes):
    type_id, payload = decode(data)
    return type_id, payload


# -- framing ------------------------------------------------------------------


def test_frame_layout():
    data = encode(MsgType.TICK_READY, {"t": 7})
    assert data[0] == 0x13  # 1-byte type header, value from shared/protocol.ts
    assert decode(data) == (0x13, {"t": 7})


def test_decode_rejects_empty_and_non_map():
    with pytest.raises(ValueError):
        decode(b"")
    import msgpack

    with pytest.raises(ValueError):
        decode(bytes([0x01]) + msgpack.packb([1, 2, 3]))


def test_msg_type_ids_match_protocol_ts():
    assert MsgType.JOIN_ROOM == 0x01
    assert MsgType.LEAVE_ROOM == 0x02
    assert MsgType.READY_TOGGLE == 0x03
    assert MsgType.INPUT_FRAME == 0x04
    assert MsgType.HASH_REPORT == 0x05
    assert MsgType.ROOM_STATE == 0x10
    assert MsgType.MATCH_START == 0x11
    assert MsgType.INPUT_BROADCAST == 0x12
    assert MsgType.TICK_READY == 0x13
    assert MsgType.STALL_NOTICE == 0x14
    assert MsgType.HASH_MISMATCH == 0x15
    assert MsgType.PLAYER_DISCONNECT == 0x16


# -- Client → Server ----------------------------------------------------------


def test_join_room():
    assert roundtrip(protocol.join_room("AB2CD", "alice", "pid-1")) == (
        MsgType.JOIN_ROOM,
        {"roomId": "AB2CD", "name": "alice", "playerId": "pid-1"},
    )


def test_join_room_create():
    assert roundtrip(protocol.join_room("", "bob")) == (
        MsgType.JOIN_ROOM,
        {"roomId": "", "name": "bob", "playerId": ""},
    )


def test_leave_room():
    assert roundtrip(protocol.leave_room()) == (MsgType.LEAVE_ROOM, {})


def test_ready_toggle():
    assert roundtrip(protocol.ready_toggle(True)) == (
        MsgType.READY_TOGGLE,
        {"ready": True},
    )


def test_input_frame():
    assert roundtrip(protocol.input_frame(42, 0b1010, 0b1)) == (
        MsgType.INPUT_FRAME,
        {"t": 42, "dirs": 0b1010, "actions": 0b1},
    )


def test_hash_report_uint32():
    h = 0xDEADBEEF  # uint32 must survive untruncated
    assert roundtrip(protocol.hash_report(900, h)) == (
        MsgType.HASH_REPORT,
        {"t": 900, "hash": h},
    )


# -- Server → Client ----------------------------------------------------------


def test_room_state():
    players = [
        {"slot": 0, "name": "alice", "ready": True, "connected": True},
        {"slot": 1, "name": "bob", "ready": False, "connected": False},
    ]
    assert roundtrip(protocol.room_state("AB2CD", 0, 1, players)) == (
        MsgType.ROOM_STATE,
        {"roomId": "AB2CD", "phase": 0, "youSlot": 1, "players": players},
    )


def test_match_start():
    config = {"moveSpeed": 5.0, "cornerAssist": 0.25, "inputBufferMs": 120}
    assert roundtrip(protocol.match_start(0xFFFFFFFF, 3, config, 0)) == (
        MsgType.MATCH_START,
        {"seed": 0xFFFFFFFF, "slot": 3, "config": config, "t0": 0},
    )


def test_input_broadcast():
    inputs = [{"dirs": 1, "actions": 0}, {"dirs": 8, "actions": 1}]
    assert roundtrip(protocol.input_broadcast(5, inputs)) == (
        MsgType.INPUT_BROADCAST,
        {"t": 5, "inputs": inputs},
    )


def test_tick_ready():
    assert roundtrip(protocol.tick_ready(123)) == (MsgType.TICK_READY, {"t": 123})


def test_stall_notice():
    assert roundtrip(protocol.stall_notice(8, [1, 3])) == (
        MsgType.STALL_NOTICE,
        {"t": 8, "waiting": [1, 3]},
    )


def test_hash_mismatch():
    assert roundtrip(protocol.hash_mismatch(30, [1, 2, 0, 0])) == (
        MsgType.HASH_MISMATCH,
        {"t": 30, "hashes": [1, 2, 0, 0]},
    )


def test_player_disconnect():
    assert roundtrip(protocol.player_disconnect(2)) == (
        MsgType.PLAYER_DISCONNECT,
        {"slot": 2},
    )
