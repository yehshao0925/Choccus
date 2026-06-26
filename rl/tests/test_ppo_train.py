# rl/tests/test_ppo_train.py
from rl.train.ppo_train import make_ppo_model, make_env


def test_make_env_returns_gymnasium_env():
    env = make_env('classic')()
    obs, info = env.reset(seed=0)
    assert 'grid' in obs and 'scalars' in obs
    env.close()


def test_ppo_model_smoke_1000_steps():
    """Verify RecurrentPPO can run 1000 steps without crash."""
    from stable_baselines3.common.vec_env import DummyVecEnv
    env = DummyVecEnv([make_env('classic')])
    model = make_ppo_model(env, n_steps=64, batch_size=32, verbose=0)
    model.learn(total_timesteps=1000)
    env.close()


def test_ppo_loads_bc_weights():
    """Verify BC extractor weights can be loaded without error."""
    import torch, tempfile, os, numpy as np
    from stable_baselines3.common.vec_env import DummyVecEnv
    from gymnasium import spaces
    from rl.train.network import ChoccusCNNExtractor
    from rl.env.constants import MAP_ROWS, MAP_COLS

    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })
    extractor = ChoccusCNNExtractor(obs_space)
    with tempfile.NamedTemporaryFile(suffix='.pt', delete=False) as f:
        torch.save(extractor.state_dict(), f.name)
        ckpt = f.name

    try:
        env = DummyVecEnv([make_env('classic')])
        model = make_ppo_model(env, n_steps=64, batch_size=32, verbose=0)
        state = torch.load(ckpt, map_location='cpu', weights_only=True)
        model.policy.features_extractor.load_state_dict(state)
        w = next(model.policy.features_extractor.parameters())
        assert w.abs().sum() > 0
        env.close()
    finally:
        os.unlink(ckpt)
