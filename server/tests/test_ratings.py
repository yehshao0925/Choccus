"""RatingStore tests (in-memory SQLite, no relay)."""

from relay.lobby import Lobby
from relay.ratings import DEFAULT_MU, DEFAULT_SIGMA, RatingStore, synthetic_bot_id


def noop(_data: bytes) -> None:
    pass


def parts(*ids_teams):
    return [{"player_id": i, "name": i, "team": t} for i, t in ids_teams]


def test_default_rating_for_unseen_player():
    s = RatingStore()
    assert s.get("nobody") == (DEFAULT_MU, DEFAULT_SIGMA)


def test_winner_gains_loser_loses_and_persists():
    s = RatingStore()
    out = s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    assert out["a"] > 0 > out["b"]  # ordinals diverge from 0
    # μ persisted: a went up, b down.
    assert s.get("a")[0] > DEFAULT_MU
    assert s.get("b")[0] < DEFAULT_MU


def test_draw_keeps_mu_but_shrinks_sigma():
    s = RatingStore()
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=None)
    mu, sigma = s.get("a")
    assert abs(mu - DEFAULT_MU) < 1e-6
    assert sigma < DEFAULT_SIGMA


def test_bot_is_rated_like_a_player():
    s = RatingStore()
    bot = synthetic_bot_id("hard")
    s.apply_match(parts(("human", 0), (bot, 1)), winner_team=1)  # bot wins
    assert s.get(bot)[0] > DEFAULT_MU
    assert s.get("human")[0] < DEFAULT_MU


def test_fewer_than_two_teams_is_noop():
    s = RatingStore()
    assert s.apply_match(parts(("a", 0), ("b", 0)), winner_team=0) == {}
    assert s.get("a") == (DEFAULT_MU, DEFAULT_SIGMA)


def test_games_accumulate_across_matches():
    s = RatingStore()
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    s.apply_match(parts(("a", 0), ("b", 1)), winner_team=0)
    games = s._db.execute("SELECT games FROM ratings WHERE player_id='a'").fetchone()[0]
    assert games == 2


def test_room_apply_result_rates_once_and_updates_scores():
    store = RatingStore()
    room = Lobby(store=store).create_room()
    room.add_player("alice", noop, "pid-a")
    room.add_player("bob", noop, "pid-b")
    room.set_ready(0, True)
    room.set_ready(1, True)
    room.start_match()
    assert room.apply_result(winner_team=0) is True  # alice (slot 0) wins
    assert room.apply_result(winner_team=0) is False  # once per match only
    assert store.get("pid-a")[0] > DEFAULT_MU > store.get("pid-b")[0]
