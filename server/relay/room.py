"""Room: one match's membership and lifecycle (LOBBY -> PLAYING -> OVER).

Tracks players by slot (0..MAX_PLAYERS-1), their ready state, and — once all
present players are ready — starts the match: generates the shared PRNG seed
(``secrets.randbits(32)``: cryptographic source, only used to *seed* the
clients' deterministic Mulberry32, never as the sim RNG itself), freezes the
authoritative FeelParams, sends each player MatchStart with their own slot,
and hands tick relaying to a TickCoordinator.

Players are plain records holding a sync ``send(data: bytes)`` callback, so
the room is unit-testable without sockets.
"""

import secrets
from collections.abc import Callable
from dataclasses import dataclass, field

from .constants import DEFAULT_FEEL_PARAMS, MAX_PLAYERS, GamePhase
from .protocol import match_start, player_disconnect, room_state
from .ratings import RatingStore, ordinal, synthetic_bot_id
from .tick_coordinator import TickCoordinator

#: First sim tick — clients start stepping from here (MatchStart.t0).
MATCH_T0 = 0

#: M5 start rule: an online match needs at least this many players (solo play
#: is the hotseat mode's job). Enforced via ``can_start()`` at the dispatch
#: layer; ``start_match()`` itself stays permissive for unit tests.
MIN_PLAYERS_TO_START = 2


@dataclass
class Player:
    name: str
    send: Callable[[bytes], None]
    ready: bool = False
    connected: bool = True
    #: Persistent rating key (localStorage id from the client; '' if anonymous).
    player_id: str = ""


#: Display name for bot-filled slots (the actual archetype is resolved
#: client-side from the chosen difficulty + rolled map, so the relay only needs
#: a label + the tier string).
BOT_NAME = "CocoaBot"

#: Accepted bot strength tiers; anything else falls back to 'normal'.
BOT_DIFFICULTIES = ("easy", "normal", "hard")


@dataclass
class Room:
    room_id: str
    phase: GamePhase = GamePhase.LOBBY
    players: dict[int, Player] = field(default_factory=dict)
    #: slot -> bot difficulty tier. Bots occupy a real slot but have no socket;
    #: every client computes their input locally (deterministic from the shared
    #: seed + tier), so the relay never relays or waits for them.
    bots: dict[int, str] = field(default_factory=dict)
    coordinator: TickCoordinator | None = None
    seed: int | None = None
    #: Authoritative rating store (shared across rooms); None disables ratings.
    store: RatingStore | None = None
    #: Guard so each match's result is applied to ratings at most once.
    _rated: bool = False

    # -- membership -----------------------------------------------------------

    def _free_slot(self, slot: int) -> bool:
        return 0 <= slot < MAX_PLAYERS and slot not in self.players and slot not in self.bots

    def add_player(
        self, name: str, send: Callable[[bytes], None], player_id: str = ""
    ) -> int | None:
        """Assign the lowest free slot; None if the room is full or in-game."""
        if self.phase != GamePhase.LOBBY or len(self.players) + len(self.bots) >= MAX_PLAYERS:
            return None
        slot = next(s for s in range(MAX_PLAYERS) if self._free_slot(s))
        self.players[slot] = Player(name=name, send=send, player_id=player_id)
        return slot

    def add_bot(self, slot: int, difficulty: str = "normal") -> bool:
        """Fill a free slot with a bot at the given tier (lobby only)."""
        if self.phase != GamePhase.LOBBY or not self._free_slot(slot):
            return False
        self.bots[slot] = difficulty if difficulty in BOT_DIFFICULTIES else "normal"
        return True

    def remove_bot(self, slot: int) -> bool:
        """Free a bot slot (lobby only)."""
        if self.phase != GamePhase.LOBBY or slot not in self.bots:
            return False
        del self.bots[slot]
        return True

    def remove_player(self, slot: int) -> None:
        """Leave (lobby: frees the slot) or disconnect (in-game: slot is kept,
        marked disconnected, excluded from lockstep, PlayerDisconnect sent)."""
        if slot not in self.players:
            return
        if self.phase == GamePhase.LOBBY:
            del self.players[slot]
        else:
            self.players[slot].connected = False
            if self.coordinator is not None:
                self.coordinator.mark_disconnected(slot)
            self.broadcast(player_disconnect(slot))

    def set_ready(self, slot: int, ready: bool) -> None:
        if self.phase == GamePhase.LOBBY and slot in self.players:
            self.players[slot].ready = ready

    def all_ready(self) -> bool:
        return bool(self.players) and all(p.ready for p in self.players.values())

    def participant_count(self) -> int:
        """Humans + bots = total players in the match."""
        return len(self.players) + len(self.bots)

    def can_start(self) -> bool:
        """Start rule: >= MIN_PLAYERS_TO_START participants (humans + bots),
        at least one human present, and every human ready. Bots are always
        ready and never gate the start (they fill empty slots)."""
        return self.participant_count() >= MIN_PLAYERS_TO_START and self.all_ready()

    def is_empty(self) -> bool:
        return not any(p.connected for p in self.players.values())

    # -- match lifecycle --------------------------------------------------------

    def start_match(self) -> None:
        """LOBBY -> PLAYING: pick the shared seed, send per-player MatchStart."""
        if self.phase != GamePhase.LOBBY or not self.players:
            return
        self.phase = GamePhase.PLAYING
        self._rated = False
        self.seed = secrets.randbits(32)
        # Participant slots = humans + bots (so the InputBroadcast array spans
        # them); bot slots are passed as `bots` so the coordinator never waits
        # on them. Clients learn which slots are bots from the final RoomState
        # roster (isBot) and run those bots locally.
        self.coordinator = TickCoordinator(
            slots=list(self.players.keys()) + list(self.bots.keys()),
            broadcast=self.broadcast,
            bots=self.bots.keys(),
        )
        config = dict(DEFAULT_FEEL_PARAMS)  # frozen for the whole match
        for slot, player in self.players.items():
            player.send(match_start(self.seed, slot, config, MATCH_T0))

    def apply_result(self, winner_team: int | None) -> bool:
        """Fold a reported match outcome into ratings (once per match).

        Net matches are FFA, so a player's team is their slot and `winner_team`
        is the winning slot (or None for a draw). Every occupied slot — humans
        (by player_id) and bots (by synthetic id) — is a participant. Returns
        True if ratings were updated (False = no store / already rated / not
        playing). The first valid report wins; lockstep hash agreement is what
        keeps a lone client from skewing the outcome."""
        if self.store is None or self._rated or self.phase != GamePhase.PLAYING:
            return False
        participants = [
            {"player_id": p.player_id or f"anon:{self.room_id}:{slot}",
             "name": p.name, "team": slot}
            for slot, p in self.players.items()
        ] + [
            {"player_id": synthetic_bot_id(tier), "name": BOT_NAME, "team": slot}
            for slot, tier in self.bots.items()
        ]
        self.store.apply_match(participants, winner_team)
        self._rated = True
        return True

    def reset_to_lobby(self) -> None:
        """PLAYING -> LOBBY (rematch). The relay never simulates, so it cannot
        observe the sim reaching OVER itself — the first ReadyToggle after
        MatchStart is the clients' "match is over, ready for a rematch"
        signal (see RelayServer._ready). Drops slots that disconnected
        mid-match, clears every ready flag and the per-match state; surviving
        players keep their slots."""
        if self.phase == GamePhase.LOBBY:
            return
        self.phase = GamePhase.LOBBY
        self.players = {s: p for s, p in self.players.items() if p.connected}
        for player in self.players.values():
            player.ready = False
        if self.coordinator is not None:
            self.coordinator.close()
            self.coordinator = None
        self.seed = None

    # -- messaging ------------------------------------------------------------------

    def broadcast(self, data: bytes) -> None:
        for player in self.players.values():
            if player.connected:
                player.send(data)

    def _score(self, player_id: str) -> float | None:
        """Display rating (μ − 3σ) for a player id, or None if ratings are off."""
        if self.store is None:
            return None
        return round(ordinal(*self.store.get(player_id)), 1)

    def broadcast_room_state(self) -> None:
        """RoomState is per-receiver (youSlot differs), so send individually."""
        roster = [
            {
                "slot": slot,
                "name": p.name,
                "ready": p.ready,
                "connected": p.connected,
                "score": self._score(p.player_id),
            }
            for slot, p in self.players.items()
        ] + [
            {
                "slot": slot,
                "name": BOT_NAME,
                "ready": True,
                "connected": True,
                "isBot": True,
                "botDifficulty": difficulty,
                "score": self._score(synthetic_bot_id(difficulty)),
            }
            for slot, difficulty in self.bots.items()
        ]
        roster.sort(key=lambda r: r["slot"])
        for slot, player in self.players.items():
            if player.connected:
                player.send(
                    room_state(self.room_id, int(self.phase), slot, roster)
                )

    # -- lifecycle --------------------------------------------------------------------

    def close(self) -> None:
        if self.coordinator is not None:
            self.coordinator.close()
