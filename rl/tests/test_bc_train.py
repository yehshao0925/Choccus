# rl/tests/test_bc_train.py
import json
import os
import tempfile
from rl.train.bc_train import train_bc


def _write_tiny_dataset(path: str, n_games: int = 2, n_ticks: int = 30):
    with open(path, 'w') as f:
        for seed in range(n_games):
            entry = {
                'seed': seed,
                'map_kind': 'classic',
                'num_players': 2,
                'ticks': [[0, 0]] * n_ticks,
            }
            f.write(json.dumps(entry) + '\n')


def test_train_bc_runs_and_saves_checkpoint():
    with tempfile.TemporaryDirectory() as tmpdir:
        data_path = f'{tmpdir}/data.jsonl'
        ckpt_path = f'{tmpdir}/bc_extractor.pt'
        _write_tiny_dataset(data_path, n_games=2, n_ticks=30)

        acc = train_bc(
            data_path=data_path,
            output_path=ckpt_path,
            epochs=1,
            batch_size=16,
        )
        assert 0.0 <= acc <= 1.0
        assert os.path.exists(ckpt_path)


def test_train_bc_checkpoint_loadable():
    """Verify saved checkpoint can be loaded back into ChoccusCNNExtractor."""
    import torch, numpy as np
    from gymnasium import spaces
    from rl.train.network import ChoccusCNNExtractor
    from rl.env.constants import MAP_ROWS, MAP_COLS

    with tempfile.TemporaryDirectory() as tmpdir:
        data_path = f'{tmpdir}/data.jsonl'
        ckpt_path = f'{tmpdir}/bc_extractor.pt'
        _write_tiny_dataset(data_path, n_games=2, n_ticks=30)
        train_bc(data_path=data_path, output_path=ckpt_path, epochs=1, batch_size=16)

        obs_space = spaces.Dict({
            'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
            'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
        })
        extractor = ChoccusCNNExtractor(obs_space)
        state = torch.load(ckpt_path, map_location='cpu', weights_only=True)
        extractor.load_state_dict(state)  # must not raise
