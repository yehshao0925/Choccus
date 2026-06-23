"""RelayServer: websocket endpoint and message dispatch.

Accepts connections, decodes the ``[1-byte type][msgpack]`` frames mirrored
from shared/protocol.ts, and routes C->S messages to lobby/room/coordinator.
Each connection gets an outbound FIFO queue drained by a writer task, so the
room/coordinator layers can stay synchronous (they just enqueue bytes) and
per-connection message order is preserved.

Note: shared/protocol.ts defines no error/NACK message, so invalid requests
(unknown room id, full room, join while already in a room, ...) are logged
and silently ignored — the client simply receives no RoomState.
"""

import asyncio
import os

from .constants import GamePhase
from .lobby import Lobby
from .protocol import MsgType, decode
from .ratings import RatingStore


def _log(msg: str) -> None:
    print(f"[choccus] {msg}", flush=True)


class Connection:
    """Per-socket state: identity (room + slot) and the outbound send queue."""

    def __init__(self, ws) -> None:
        self.ws = ws
        self.room = None
        self.slot: int | None = None
        self._queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._writer = asyncio.create_task(self._drain())

    def send(self, data: bytes) -> None:
        """Sync enqueue — safe to call from rooms/coordinator."""
        self._queue.put_nowait(data)

    async def _drain(self) -> None:
        try:
            while True:
                await self.ws.send(await self._queue.get())
        except Exception:
            pass  # socket closed mid-send; reader loop handles cleanup

    def close(self) -> None:
        self._writer.cancel()


class RelayServer:
    def __init__(self, db_path: str | None = None) -> None:
        # Ratings persist to SQLite (path via CHOCCUS_RATINGS_DB, default file).
        path = db_path or os.environ.get("CHOCCUS_RATINGS_DB", "choccus-ratings.db")
        self.store = RatingStore(path)
        self.lobby = Lobby(store=self.store)

    async def handler(self, ws) -> None:
        """websockets connection handler (pass to websockets serve())."""
        conn = Connection(ws)
        peer = ws.remote_address
        _log(f"client connected: {peer}")
        try:
            async for raw in ws:
                if not isinstance(raw, (bytes, bytearray)):
                    _log(f"ignoring non-binary frame from {peer}")
                    continue
                try:
                    type_id, payload = decode(bytes(raw))
                except Exception as exc:
                    _log(f"bad frame from {peer}: {exc}")
                    continue
                self._dispatch(conn, type_id, payload)
        finally:
            self._leave(conn)
            conn.close()
            _log(f"client disconnected: {peer}")

    # -- dispatch ----------------------------------------------------------------

    def _dispatch(self, conn: Connection, type_id: int, payload: dict) -> None:
        if type_id == MsgType.JOIN_ROOM:
            self._join(conn, payload)
        elif type_id == MsgType.LEAVE_ROOM:
            self._leave(conn)
        elif type_id == MsgType.READY_TOGGLE:
            self._ready(conn, payload)
        elif type_id == MsgType.ADD_BOT:
            self._add_bot(conn, payload)
        elif type_id == MsgType.REMOVE_BOT:
            self._remove_bot(conn, payload)
        elif type_id == MsgType.MATCH_RESULT:
            self._match_result(conn, payload)
        elif type_id == MsgType.INPUT_FRAME:
            self._input(conn, payload)
        elif type_id == MsgType.HASH_REPORT:
            self._hash(conn, payload)
        else:
            _log(f"unknown message type 0x{type_id:02x}")

    def _join(self, conn: Connection, payload: dict) -> None:
        if conn.room is not None:
            _log("join ignored: connection already in a room")
            return
        room_id = str(payload.get("roomId", ""))
        name = str(payload.get("name", ""))
        player_id = str(payload.get("playerId", ""))
        # '' = create a fresh random-id room; a named id joins the existing
        # room or auto-creates it (lets clients meet at e.g. ?room=test).
        room = (
            self.lobby.create_room()
            if room_id == ""
            else self.lobby.get_or_create(room_id)
        )
        slot = room.add_player(name, conn.send, player_id)
        if slot is None:  # only possible for an existing room (full / playing)
            _log(f"join ignored: room {room.room_id} full or already playing")
            return
        conn.room, conn.slot = room, slot
        _log(f"{name!r} joined room {room.room_id} as slot {slot}")
        room.broadcast_room_state()

    def _leave(self, conn: Connection) -> None:
        room, slot = conn.room, conn.slot
        if room is None or slot is None:
            return
        conn.room = conn.slot = None
        room.remove_player(slot)
        if room.is_empty():
            _log(f"room {room.room_id} empty — closing")
            self.lobby.remove_room(room.room_id)
        elif room.phase == GamePhase.LOBBY:
            room.broadcast_room_state()

    def _ready(self, conn: Connection, payload: dict) -> None:
        room, slot = conn.room, conn.slot
        if room is None or slot is None:
            return
        if room.phase != GamePhase.LOBBY:
            # The relay never simulates, so it cannot see the sim reach OVER;
            # a ReadyToggle while PLAYING is the client's rematch signal —
            # reset the room to LOBBY (drops disconnected slots), then apply
            # the toggle below as usual.
            _log(f"room {room.room_id}: rematch requested — back to lobby")
            room.reset_to_lobby()
        room.set_ready(slot, bool(payload.get("ready")))
        room.broadcast_room_state()
        if room.can_start():
            _log(
                f"room {room.room_id}: {len(room.players)} players all ready"
                " — starting match"
            )
            room.start_match()

    def _add_bot(self, conn: Connection, payload: dict) -> None:
        room = conn.room
        if room is None:
            return
        try:
            slot = int(payload["slot"])
        except (KeyError, TypeError, ValueError):
            return
        difficulty = str(payload.get("difficulty", "normal"))
        if room.add_bot(slot, difficulty):
            _log(f"room {room.room_id}: {difficulty} bot added to slot {slot}")
            room.broadcast_room_state()

    def _remove_bot(self, conn: Connection, payload: dict) -> None:
        room = conn.room
        if room is None:
            return
        try:
            slot = int(payload["slot"])
        except (KeyError, TypeError, ValueError):
            return
        if room.remove_bot(slot):
            _log(f"room {room.room_id}: bot removed from slot {slot}")
            room.broadcast_room_state()

    def _match_result(self, conn: Connection, payload: dict) -> None:
        room = conn.room
        if room is None:
            return
        winner = payload.get("winnerTeam")
        winner_team = int(winner) if isinstance(winner, (int, float)) else None
        if room.apply_result(winner_team):
            _log(f"room {room.room_id}: ratings updated (winner={winner_team})")
            # Push the fresh scores so the post-match lobby shows them.
            room.broadcast_room_state()

    def _input(self, conn: Connection, payload: dict) -> None:
        room, slot = conn.room, conn.slot
        if room is None or slot is None or room.coordinator is None:
            return
        try:
            t = int(payload["t"])
            dirs = int(payload["dirs"])
            actions = int(payload["actions"])
        except (KeyError, TypeError, ValueError):
            _log("malformed InputFrame ignored")
            return
        room.coordinator.on_input(slot, t, dirs, actions)

    def _hash(self, conn: Connection, payload: dict) -> None:
        room, slot = conn.room, conn.slot
        if room is None or slot is None or room.coordinator is None:
            return
        try:
            t = int(payload["t"])
            hash_ = int(payload["hash"])
        except (KeyError, TypeError, ValueError):
            _log("malformed HashReport ignored")
            return
        room.coordinator.on_hash(slot, t, hash_)
