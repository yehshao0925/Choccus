"""TickCoordinator: lockstep input collection and broadcast for one match.

Pure relay — never simulates. For each sim tick ``t`` (starting at
``t0 + INPUT_DELAY_TICKS``) it waits until every *connected* slot has
submitted an InputFrame, then broadcasts exactly one InputBroadcast followed
by TickReady, and moves on. Missing inputs past the stall timeout trigger
periodic StallNotice broadcasts (ticks never advance on a stall).

HashReports are compared per tick across connected slots; any divergence
broadcasts HashMismatch (v1: detection only).

The last ``INPUT_HISTORY_SIZE`` InputBroadcast frames are kept in
``self.history`` for the M5 reconnect catch-up flow.

Sockets are abstracted away behind a ``broadcast(data: bytes)`` callback so
the class is unit-testable without an event loop (the stall timer is simply
skipped when no loop is running).
"""

import asyncio
from collections import deque
from collections.abc import Callable, Iterable

from .constants import (
    INPUT_DELAY_TICKS,
    INPUT_HISTORY_SIZE,
    MAX_TICK_LEAD,
    STALL_TIMEOUT_MS,
)
from .protocol import hash_mismatch, input_broadcast, stall_notice, tick_ready

#: Neutral input substituted for slots with no frame (disconnected / vacated).
NEUTRAL_INPUT = (0, 0)


class TickCoordinator:
    def __init__(
        self,
        slots: Iterable[int],
        broadcast: Callable[[bytes], None],
        *,
        bots: Iterable[int] = (),
        first_tick: int = INPUT_DELAY_TICKS,
        stall_timeout_ms: float = STALL_TIMEOUT_MS,
        history_size: int = INPUT_HISTORY_SIZE,
    ) -> None:
        self.slots = frozenset(slots)  # slots baked into the match, never change
        # Bot slots occupy a slot (so the InputBroadcast width covers them, and
        # clients fill them with locally-computed deterministic input) but are
        # NEVER waited on: they never send a socket frame. Same effect as a
        # permanently-disconnected slot, except clients substitute bot input
        # instead of neutral ghost input.
        self.bots = frozenset(bots)
        self.connected: set[int] = set(self.slots) - self.bots
        self.broadcast = broadcast
        self.next_tick = first_tick
        #: t -> slot -> (dirs, actions); only keys >= next_tick are kept.
        self.inputs: dict[int, dict[int, tuple[int, int]]] = {}
        #: t -> slot -> hash (pending hash reports).
        self.hashes: dict[int, dict[int, int]] = {}
        #: Recent (t, encoded InputBroadcast) frames for reconnect catch-up (M5).
        self.history: deque[tuple[int, bytes]] = deque(maxlen=history_size)
        self._stall_timeout = stall_timeout_ms / 1000.0
        self._stall_handle: asyncio.TimerHandle | None = None
        # InputBroadcast.inputs is indexed by slot (shared/protocol.ts), so the
        # array spans 0..max(slot); gaps are filled with neutral input.
        self._width = max(self.slots) + 1

    # -- inputs ----------------------------------------------------------------

    def on_input(self, slot: int, t: int, dirs: int, actions: int) -> None:
        """Record one slot's InputFrame for sim tick t and advance if complete."""
        if slot not in self.slots or not (
            self.next_tick <= t <= self.next_tick + MAX_TICK_LEAD
        ):
            return  # unknown slot, late frame, or out of the bounded forward
            # window (untrusted t: drop distant future ticks so a flooding
            # client can't grow self.inputs without bound — remote OOM)
        self.inputs.setdefault(t, {})[slot] = (dirs, actions)
        self._advance()

    def mark_disconnected(self, slot: int) -> None:
        """Stop requiring this slot's input (ghost input is applied client-side)."""
        if slot not in self.connected:
            return
        self.connected.discard(slot)
        self._advance()  # the missing slot may have been the only blocker
        for t in sorted(self.hashes):
            self._check_hashes(t)

    def _tick_complete(self, t: int) -> bool:
        got = self.inputs.get(t, {})
        return all(slot in got for slot in self.connected)

    def _advance(self) -> None:
        advanced = False
        while self.connected and self._tick_complete(self.next_tick):
            t = self.next_tick
            got = self.inputs.pop(t, {})
            inputs = [
                {"dirs": dirs, "actions": actions}
                for dirs, actions in (
                    got.get(slot, NEUTRAL_INPUT) for slot in range(self._width)
                )
            ]
            frame = input_broadcast(t, inputs)
            self.history.append((t, frame))
            self.broadcast(frame)
            self.broadcast(tick_ready(t))
            self.next_tick += 1
            advanced = True
        if advanced:
            # Drop stale partial hash reports that fell below next_tick: they can
            # never complete (the tick has passed), so without this a client that
            # reports a never-completed in-window tick per advance leaks hashes.
            self.hashes = {t: g for t, g in self.hashes.items() if t >= self.next_tick}
        self._update_stall_timer()

    # -- stall detection ---------------------------------------------------------

    def waiting_slots(self) -> list[int]:
        """Connected slots that have not submitted input for the next tick."""
        got = self.inputs.get(self.next_tick, {})
        return sorted(slot for slot in self.connected if slot not in got)

    def _update_stall_timer(self) -> None:
        # A stall is only meaningful once someone is ahead: any buffered input
        # for >= next_tick means at least one client is waiting on the rest.
        if self.inputs and self.waiting_slots():
            if self._stall_handle is None:
                self._arm_stall_timer()
        else:
            self._cancel_stall_timer()

    def _arm_stall_timer(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # no event loop (sync unit tests) — stall detection off
        self._stall_handle = loop.call_later(self._stall_timeout, self._on_stall)

    def _cancel_stall_timer(self) -> None:
        if self._stall_handle is not None:
            self._stall_handle.cancel()
            self._stall_handle = None

    def _on_stall(self) -> None:
        self._stall_handle = None
        waiting = self.waiting_slots()
        if self.inputs and waiting:
            self.broadcast(stall_notice(self.next_tick, waiting))
            self._arm_stall_timer()  # keep notifying until the tick completes

    # -- hash reports --------------------------------------------------------------

    def on_hash(self, slot: int, t: int, hash_: int) -> None:
        """Record a HashReport; once all connected slots reported t, compare."""
        if slot not in self.slots or not (
            self.next_tick <= t <= self.next_tick + MAX_TICK_LEAD
        ):
            return  # unknown slot, or out of the bounded forward window: a hash
            # for an already-advanced tick (t < next_tick) can never be compared,
            # and an unbounded future t would grow self.hashes forever (OOM)
        self.hashes.setdefault(t, {})[slot] = hash_
        self._check_hashes(t)

    def _check_hashes(self, t: int) -> None:
        got = self.hashes.get(t)
        if got is None or not all(slot in got for slot in self.connected):
            return
        if len(set(got.values())) > 1:
            self.broadcast(
                hash_mismatch(t, [got.get(slot, 0) for slot in range(self._width)])
            )
        del self.hashes[t]

    # -- lifecycle -------------------------------------------------------------------

    def close(self) -> None:
        self._cancel_stall_timer()
