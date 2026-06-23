"""Lobby: room registry and matchmaking entry point.

Creates rooms with short shareable ids, looks them up for joins, and drops
them when the last player is gone. Joining a named room that does not exist
auto-creates it under that id (so two clients can meet at ?room=test with
zero coordination); an empty room id still generates a fresh random id.
Slot assignment and ready/start logic live in Room; the lobby only owns the
registry.
"""

from util.id_gen import generate_room_id

from .ratings import RatingStore
from .room import Room


class Lobby:
    def __init__(self, store: RatingStore | None = None) -> None:
        self.rooms: dict[str, Room] = {}
        self.store = store

    def create_room(self, room_id: str = "") -> Room:
        """Create a room; empty id = generate a fresh shareable random id."""
        if room_id == "":
            room_id = generate_room_id(taken=self.rooms)
        room = Room(room_id=room_id, store=self.store)
        self.rooms[room_id] = room
        return room

    def get_or_create(self, room_id: str) -> Room:
        """Look up a named room, auto-creating it if the id is unknown."""
        room = self.rooms.get(room_id)
        return room if room is not None else self.create_room(room_id)

    def get(self, room_id: str) -> Room | None:
        return self.rooms.get(room_id)

    def remove_room(self, room_id: str) -> None:
        room = self.rooms.pop(room_id, None)
        if room is not None:
            room.close()

    def list_rooms(self) -> list[Room]:
        return list(self.rooms.values())
