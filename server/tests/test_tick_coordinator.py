"""TickCoordinator lockstep tests (fake broadcast callback, no sockets)."""

import asyncio

from relay.constants import MAX_TICK_LEAD
from relay.protocol import MsgType, decode
from relay.tick_coordinator import TickCoordinator


class Capture:
    """Records decoded outbound broadcasts."""

    def __init__(self):
        self.msgs: list[tuple[int, dict]] = []

    def __call__(self, data: bytes) -> None:
        self.msgs.append(decode(data))

    def of_type(self, type_id: int) -> list[dict]:
        return [p for t, p in self.msgs if t == type_id]


def make(slots=(0, 1), **kwargs):
    out = Capture()
    coord = TickCoordinator(slots=slots, broadcast=out, first_tick=2, **kwargs)
    return coord, out


# -- input completeness ------------------------------------------------------


def test_tick_broadcast_once_all_slots_submitted():
    coord, out = make()
    coord.on_input(0, 2, dirs=1, actions=0)
    assert out.msgs == []  # waiting on slot 1
    coord.on_input(1, 2, dirs=8, actions=1)
    broadcasts = out.of_type(MsgType.INPUT_BROADCAST)
    ready = out.of_type(MsgType.TICK_READY)
    assert broadcasts == [
        {"t": 2, "inputs": [{"dirs": 1, "actions": 0}, {"dirs": 8, "actions": 1}]}
    ]
    assert ready == [{"t": 2}]
    assert coord.next_tick == 3


def test_inputs_ordered_by_slot_regardless_of_arrival():
    coord, out = make()
    coord.on_input(1, 2, dirs=2, actions=0)  # slot 1 first
    coord.on_input(0, 2, dirs=4, actions=1)
    [bc] = out.of_type(MsgType.INPUT_BROADCAST)
    assert bc["inputs"] == [{"dirs": 4, "actions": 1}, {"dirs": 2, "actions": 0}]


def test_future_ticks_buffered_then_cascade():
    coord, out = make()
    coord.on_input(0, 2, 1, 0)
    coord.on_input(0, 3, 1, 0)
    coord.on_input(1, 3, 2, 0)
    assert out.of_type(MsgType.INPUT_BROADCAST) == []  # tick 2 still incomplete
    coord.on_input(1, 2, 2, 0)  # completes 2 AND unblocks buffered 3
    assert [b["t"] for b in out.of_type(MsgType.INPUT_BROADCAST)] == [2, 3]
    assert [r["t"] for r in out.of_type(MsgType.TICK_READY)] == [2, 3]


def test_late_and_duplicate_inputs_ignored():
    coord, out = make()
    coord.on_input(0, 2, 1, 0)
    coord.on_input(1, 2, 2, 0)
    before = len(out.msgs)
    coord.on_input(0, 2, 9, 9)  # tick 2 already broadcast
    coord.on_input(7, 3, 1, 0)  # unknown slot
    assert len(out.msgs) == before


def test_input_beyond_forward_window_is_dropped():
    # A flooding client sending distant future ticks must not grow self.inputs.
    coord, out = make()  # next_tick == 2, window == [2, 2 + MAX_TICK_LEAD]
    coord.on_input(0, 2 + MAX_TICK_LEAD, 1, 0)  # at the edge: accepted
    coord.on_input(0, 2 + MAX_TICK_LEAD + 1, 1, 0)  # just past: dropped
    coord.on_input(0, 2**31, 1, 0)  # far future flood: dropped
    coord.on_input(0, 2**31 + 1, 1, 0)
    assert set(coord.inputs) == {2 + MAX_TICK_LEAD}  # only the in-window tick kept
    assert out.msgs == []  # nothing broadcast


def test_history_buffer_for_reconnect():
    coord, out = make(history_size=4)
    for t in range(2, 12):
        coord.on_input(0, t, 1, 0)
        coord.on_input(1, t, 2, 0)
    assert [t for t, _ in coord.history] == [8, 9, 10, 11]  # last 4 only


def test_gap_slot_filled_with_neutral_input():
    # Players in slots 0 and 2 (slot 1 left the lobby pre-start): the
    # inputs array is indexed by slot, so index 1 is neutral.
    coord, out = make(slots=(0, 2))
    coord.on_input(0, 2, 1, 0)
    coord.on_input(2, 2, 8, 1)
    [bc] = out.of_type(MsgType.INPUT_BROADCAST)
    assert bc["inputs"] == [
        {"dirs": 1, "actions": 0},
        {"dirs": 0, "actions": 0},
        {"dirs": 8, "actions": 1},
    ]


# -- disconnects ----------------------------------------------------------------


def test_disconnected_slot_excluded_from_completeness():
    coord, out = make()
    coord.on_input(0, 2, 1, 0)
    assert out.of_type(MsgType.INPUT_BROADCAST) == []
    coord.mark_disconnected(1)  # slot 1 gone: tick 2 must now advance
    [bc] = out.of_type(MsgType.INPUT_BROADCAST)
    assert bc["t"] == 2
    assert bc["inputs"][1] == {"dirs": 0, "actions": 0}  # neutral for the ghost
    # subsequent ticks only need slot 0
    coord.on_input(0, 3, 4, 0)
    assert [b["t"] for b in out.of_type(MsgType.INPUT_BROADCAST)] == [2, 3]


def test_all_disconnected_does_not_spin():
    coord, out = make()
    coord.mark_disconnected(0)
    coord.mark_disconnected(1)
    assert out.of_type(MsgType.INPUT_BROADCAST) == []
    assert coord.next_tick == 2


# -- stall detection -------------------------------------------------------------


def test_stall_notice_after_timeout_then_recovery():
    async def run():
        coord, out = make(stall_timeout_ms=30)
        coord.on_input(0, 2, 1, 0)  # slot 1 missing
        await asyncio.sleep(0.1)
        stalls = out.of_type(MsgType.STALL_NOTICE)
        assert stalls, "expected at least one StallNotice"
        assert all(s == {"t": 2, "waiting": [1]} for s in stalls)
        assert coord.next_tick == 2  # never advanced during the stall

        coord.on_input(1, 2, 2, 0)  # recovery
        assert [b["t"] for b in out.of_type(MsgType.INPUT_BROADCAST)] == [2]
        n = len(out.of_type(MsgType.STALL_NOTICE))
        await asyncio.sleep(0.1)
        assert len(out.of_type(MsgType.STALL_NOTICE)) == n  # timer cancelled

    asyncio.run(run())


def test_no_stall_notice_when_nobody_submitted():
    async def run():
        coord, out = make(stall_timeout_ms=30)
        await asyncio.sleep(0.1)  # no inputs at all -> nobody is waiting
        assert out.of_type(MsgType.STALL_NOTICE) == []

    asyncio.run(run())


# -- hash reports ------------------------------------------------------------------


def test_matching_hashes_no_mismatch():
    coord, out = make()
    coord.on_hash(0, 30, 0xABCD1234)
    assert out.of_type(MsgType.HASH_MISMATCH) == []
    coord.on_hash(1, 30, 0xABCD1234)
    assert out.of_type(MsgType.HASH_MISMATCH) == []
    assert coord.hashes == {}  # record cleared after comparison


def test_differing_hashes_broadcast_mismatch():
    coord, out = make()
    coord.on_hash(0, 30, 0x11111111)
    coord.on_hash(1, 30, 0x22222222)
    assert out.of_type(MsgType.HASH_MISMATCH) == [
        {"t": 30, "hashes": [0x11111111, 0x22222222]}
    ]


def test_hash_compare_skips_disconnected_slot():
    coord, out = make()
    coord.on_hash(0, 30, 0x11111111)
    coord.mark_disconnected(1)  # comparison completes with slot 0 alone
    assert coord.hashes == {}
    assert out.of_type(MsgType.HASH_MISMATCH) == []


def test_hash_outside_forward_window_is_dropped():
    # on_hash has no notion of "complete" without all slots, so an out-of-window
    # report must be refused at the door or self.hashes grows without bound.
    coord, out = make()  # next_tick == 2
    coord.on_hash(0, 1, 0xAAAA)  # below next_tick: can never be compared
    coord.on_hash(0, 2 + MAX_TICK_LEAD + 1, 0xBBBB)  # past window: flood
    coord.on_hash(0, 2**31, 0xCCCC)
    assert coord.hashes == {}  # all rejected


def test_partial_hashes_below_next_tick_are_pruned_on_advance():
    # A client reporting a never-completed in-window tick each advance would
    # leak self.hashes; advancing past such a tick must drop the stale entry.
    coord, out = make()
    coord.on_hash(0, 5, 0xDEAD)  # only slot 0; slot 1 never reports tick 5
    assert coord.hashes == {5: {0: 0xDEAD}}
    for t in range(2, 7):  # drive next_tick past 5
        coord.on_input(0, t, 1, 0)
        coord.on_input(1, t, 2, 0)
    assert coord.next_tick == 7
    assert coord.hashes == {}  # stale partial entry pruned, no leak
