# rl/tests/test_self_play.py
from rl.train.self_play import CheckpointPool, elo_expected, elo_update


def test_elo_expected_equal_rating():
    assert abs(elo_expected(1500, 1500) - 0.5) < 1e-6


def test_elo_expected_higher_rated_favoured():
    assert elo_expected(1600, 1400) > 0.5


def test_elo_update_win_increases_winner():
    a_new, b_new = elo_update(1500, 1500, score=1.0, k=32)
    assert a_new > 1500
    assert b_new < 1500
    assert abs((a_new - 1500) + (b_new - 1500)) < 1e-6


def test_elo_update_draw_unchanged_equal():
    a_new, b_new = elo_update(1500, 1500, score=0.5, k=32)
    assert abs(a_new - 1500) < 1e-6
    assert abs(b_new - 1500) < 1e-6


def test_pool_add_and_size_cap():
    pool = CheckpointPool(max_size=8)
    for i in range(10):
        pool.add(f'ckpt_{i}.zip', elo=1500 + i * 10)
    assert len(pool.entries) == 8


def test_pool_evicts_lowest_elo():
    pool = CheckpointPool(max_size=3)
    pool.add('low.zip',  elo=1300)
    pool.add('mid.zip',  elo=1500)
    pool.add('high.zip', elo=1700)
    pool.add('new.zip',  elo=1600)
    paths = [e.path for e in pool.entries]
    assert 'low.zip' not in paths
    assert 'new.zip' in paths


def test_pool_sample_returns_valid_path():
    pool = CheckpointPool()
    pool.add('a.zip', elo=1500)
    pool.add('b.zip', elo=1600)
    path = pool.sample(current_elo=1550)
    assert path in ('a.zip', 'b.zip')


def test_pool_update_elo():
    pool = CheckpointPool()
    pool.add('a.zip', elo=1500)
    pool.add('b.zip', elo=1500)
    pool.update('a.zip', 'b.zip', score=1.0)
    a = next(e for e in pool.entries if e.path == 'a.zip')
    b = next(e for e in pool.entries if e.path == 'b.zip')
    assert a.elo > 1500
    assert b.elo < 1500
