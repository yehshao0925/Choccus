"""Tests for Mulberry32 PRNG implementation."""
import pytest
from rl.env.prng import prng_next, prng_float, prng_int


def test_prng_next_known_vector():
    """Test that prngNext(0) produces the expected state."""
    # JavaScript: prngNext(0) → s = (0 + 0x6D2B79F5) & 0xFFFFFFFF = 0x6D2B79F5
    out, new_state = prng_next(0)
    assert new_state == 0x6D2B79F5
    # out is deterministic — verify it stays the same across runs
    out2, _ = prng_next(0)
    assert out == out2


def test_prng_next_chain():
    """Two sequential calls must thread state correctly."""
    out1, s1 = prng_next(42)
    out2, s2 = prng_next(s1)
    out3, s3 = prng_next(s2)
    # All outputs must be different (extremely unlikely to collide)
    assert len({out1, out2, out3}) == 3


def test_prng_float_range():
    """prng_float must produce values in [0, 1)."""
    s = 12345
    for _ in range(1000):
        v, s = prng_float(s)
        assert 0.0 <= v < 1.0


def test_prng_int_range():
    """prng_int must produce values in [min, max_inclusive]."""
    s = 99999
    for _ in range(1000):
        v, s = prng_int(s, 0, 2)
        assert v in (0, 1, 2)


def test_prng_int_span():
    """prng_int should eventually produce all values in range."""
    s = 1
    seen = set()
    for _ in range(1000):
        v, s = prng_int(s, 0, 5)
        seen.add(v)
    assert seen == {0, 1, 2, 3, 4, 5}
