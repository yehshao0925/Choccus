"""
Mulberry32 — seeded deterministic PRNG for the simulation.

The entire generator state is a single uint32 carried in the environment.
All functions are pure: they return (value, newState) and the caller MUST
thread the new state back. This matches the TypeScript implementation exactly.

Ported from client/src/sim/Prng.ts.
"""

_MASK = 0xFFFF_FFFF


def prng_next(state: int) -> tuple[int, int]:
    """
    Advance the generator once.
    Returns (uint32 output, new uint32 state).

    Mirrors: prngNext(state) in Prng.ts
    """
    # s = (state + 0x6d2b79f5) >>> 0
    s = (state + 0x6D2B79F5) & _MASK

    t = s

    # t = Math.imul(t ^ (t >>> 15), t | 1)
    # In Python: * is unbounded, so mask after each multiplication
    t = ((t ^ (t >> 15)) * (t | 1)) & _MASK

    # t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    inner = ((t ^ (t >> 7)) * (t | 61)) & _MASK
    t = (t ^ (t + inner)) & _MASK

    # return [(t ^ (t >>> 14)) >>> 0, s]
    return ((t ^ (t >> 14)) & _MASK, s)


def prng_float(state: int) -> tuple[float, int]:
    """
    Uniform float in [0, 1) — comparison use only.
    The float must never be stored in sim state.

    Mirrors: prngFloat(state) in Prng.ts
    """
    v, s = prng_next(state)
    return v / 4_294_967_296.0, s


def prng_int(state: int, min_val: int, max_inclusive: int) -> tuple[int, int]:
    """
    Uniform integer in [min_val, max_inclusive].

    Mirrors: prngInt(state, min, maxInclusive) in Prng.ts
    """
    v, s = prng_next(state)
    span = max_inclusive - min_val + 1
    return min_val + (v % span), s
