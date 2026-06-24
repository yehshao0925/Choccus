"""End-to-end wire tests: real websockets server + two real clients.

Proves the framing, dispatch and lobby->match flow work over actual sockets;
the detailed lockstep behaviour is covered by the unit tests.
"""

import asyncio

import pytest
from websockets.asyncio.client import connect
from websockets.asyncio.server import serve

from relay import protocol
from relay.constants import MAX_NAME_LEN, MAX_ROOM_ID_LEN
from relay.protocol import MsgType, decode
from relay.relay_server import RelayServer


async def recv_until(ws, type_id: int, timeout: float = 2.0) -> dict:
    """Receive frames until one of the wanted type arrives; return its payload."""
    async with asyncio.timeout(timeout):
        while True:
            tid, payload = decode(await ws.recv())
            if tid == type_id:
                return payload


async def with_server(test_body):
    relay = RelayServer(db_path=":memory:")
    async with serve(relay.handler, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]
        await test_body(f"ws://localhost:{port}")


def test_two_clients_join_ready_matchstart_and_tick_relay():
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            # A creates a room (roomId "" = create).
            await a.send(protocol.join_room("", "alice"))
            state_a = await recv_until(a, MsgType.ROOM_STATE)
            room_id = state_a["roomId"]
            assert state_a["youSlot"] == 0
            assert state_a["phase"] == 0
            assert state_a["players"] == [
                {
                    "slot": 0,
                    "name": "alice",
                    "ready": False,
                    "connected": True,
                    "score": 0.0,
                }
            ]

            # B joins by id; both get the updated roster.
            await b.send(protocol.join_room(room_id, "bob"))
            state_b = await recv_until(b, MsgType.ROOM_STATE)
            assert state_b["youSlot"] == 1
            assert [p["name"] for p in state_b["players"]] == ["alice", "bob"]

            # Both ready up -> MatchStart with identical seed/config/t0,
            # different slots.
            await a.send(protocol.ready_toggle(True))
            await b.send(protocol.ready_toggle(True))
            start_a = await recv_until(a, MsgType.MATCH_START)
            start_b = await recv_until(b, MsgType.MATCH_START)
            assert start_a["seed"] == start_b["seed"]
            assert 0 <= start_a["seed"] < 2**32
            assert start_a["config"] == start_b["config"]
            assert start_a["config"] == {
                "moveSpeed": 5.0,
                "cornerAssist": 0.25,
                "inputBufferMs": 120,
            }
            assert start_a["t0"] == start_b["t0"] == 0
            assert {start_a["slot"], start_b["slot"]} == {0, 1}

            # Relay one full tick (first expected tick = t0 + INPUT_DELAY_TICKS).
            await a.send(protocol.input_frame(2, dirs=1, actions=0))
            await b.send(protocol.input_frame(2, dirs=8, actions=1))
            for ws in (a, b):
                bc = await recv_until(ws, MsgType.INPUT_BROADCAST)
                assert bc == {
                    "t": 2,
                    "inputs": [
                        {"dirs": 1, "actions": 0},
                        {"dirs": 8, "actions": 1},
                    ],
                }
                ready = await recv_until(ws, MsgType.TICK_READY)
                assert ready == {"t": 2}

    asyncio.run(with_server(body))


def test_disconnect_mid_match_broadcasts_and_unblocks():
    async def body(url: str):
        async with connect(url) as a:
            async with connect(url) as b:
                await a.send(protocol.join_room("", "alice"))
                state = await recv_until(a, MsgType.ROOM_STATE)
                await b.send(protocol.join_room(state["roomId"], "bob"))
                await a.send(protocol.ready_toggle(True))
                await b.send(protocol.ready_toggle(True))
                await recv_until(a, MsgType.MATCH_START)
                await recv_until(b, MsgType.MATCH_START)
            # b's socket closed mid-match -> PlayerDisconnect{slot:1} to a.
            gone = await recv_until(a, MsgType.PLAYER_DISCONNECT)
            assert gone == {"slot": 1}

            # a alone now drives the lockstep.
            await a.send(protocol.input_frame(2, dirs=2, actions=0))
            bc = await recv_until(a, MsgType.INPUT_BROADCAST)
            assert bc["t"] == 2
            assert bc["inputs"][1] == {"dirs": 0, "actions": 0}  # ghost slot

    asyncio.run(with_server(body))


def test_solo_ready_does_not_start_match():
    # M5 start rule: all-ready only counts with >= 2 players in the room.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            await a.send(protocol.ready_toggle(True))
            ready_state = await recv_until(a, MsgType.ROOM_STATE)
            assert ready_state["players"][0]["ready"] is True
            with pytest.raises(TimeoutError):
                await recv_until(a, MsgType.MATCH_START, timeout=0.3)

            # Second player joins and readies -> now it starts.
            await b.send(protocol.join_room(state["roomId"], "bob"))
            await recv_until(b, MsgType.ROOM_STATE)
            await b.send(protocol.ready_toggle(True))
            start_a = await recv_until(a, MsgType.MATCH_START)
            start_b = await recv_until(b, MsgType.MATCH_START)
            assert start_a["seed"] == start_b["seed"]

    asyncio.run(with_server(body))


def test_rematch_ready_toggle_resets_room_and_restarts():
    # After a match, ReadyToggle is the rematch signal: the room drops back
    # to LOBBY (ready flags cleared) and a second MatchStart fires once both
    # players ready up again, with a freshly drawn seed.
    async def body(url: str):
        async with connect(url) as a, connect(url) as b:
            await a.send(protocol.join_room("", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE)
            await b.send(protocol.join_room(state["roomId"], "bob"))
            await recv_until(b, MsgType.ROOM_STATE)
            await a.send(protocol.ready_toggle(True))
            await b.send(protocol.ready_toggle(True))
            first_a = await recv_until(a, MsgType.MATCH_START)
            await recv_until(b, MsgType.MATCH_START)

            # First rematch request: room resets, requester is the only ready.
            await a.send(protocol.ready_toggle(True))
            reset_state = await recv_until(b, MsgType.ROOM_STATE)
            assert reset_state["phase"] == 0  # back to LOBBY
            ready_by_slot = {p["slot"]: p["ready"] for p in reset_state["players"]}
            assert ready_by_slot == {0: True, 1: False}

            # Second player readies up -> second MatchStart, new seed.
            await b.send(protocol.ready_toggle(True))
            second_a = await recv_until(a, MsgType.MATCH_START)
            second_b = await recv_until(b, MsgType.MATCH_START)
            assert second_a["seed"] == second_b["seed"]
            assert second_a["seed"] != first_a["seed"]  # 2**-32 flake odds
            assert {second_a["slot"], second_b["slot"]} == {0, 1}

            # The new coordinator relays ticks for the new match.
            await a.send(protocol.input_frame(2, dirs=4, actions=0))
            await b.send(protocol.input_frame(2, dirs=8, actions=0))
            bc = await recv_until(a, MsgType.INPUT_BROADCAST)
            assert bc["t"] == 2

    asyncio.run(with_server(body))


def test_oversized_join_fields_are_truncated_not_crashing():
    # Untrusted name/roomId are capped on ingest before broadcast/storage.
    async def body(url: str):
        async with connect(url) as a:
            big_name = "N" * 200
            big_room = "R" * 200
            await a.send(protocol.join_room(big_room, big_name, "P" * 500))
            state = await recv_until(a, MsgType.ROOM_STATE, timeout=0.5)
            assert state["roomId"] == "R" * MAX_ROOM_ID_LEN
            assert state["players"][0]["name"] == "N" * MAX_NAME_LEN

    asyncio.run(with_server(body))


def test_join_named_room_auto_creates_it():
    # Joining a room id that does not exist creates it under that id, so two
    # clients can meet at e.g. ?room=test with no prior coordination.
    async def body(url: str):
        async with connect(url) as a:
            await a.send(protocol.join_room("ZZZZZ", "alice"))
            state = await recv_until(a, MsgType.ROOM_STATE, timeout=0.5)
            assert state["roomId"] == "ZZZZZ"
            assert state["youSlot"] == 0
            assert [p["name"] for p in state["players"]] == ["alice"]

    asyncio.run(with_server(body))
