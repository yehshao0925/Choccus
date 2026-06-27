# rl/train/bc_train.py
"""
Behavior Cloning pretraining for ChoccusCNNExtractor.
Trains extractor + Linear(512,6) on v6:hunter trajectories.
Saves extractor state_dict for loading into RecurrentPPO.

Usage:
  rl/.venv/bin/python -m rl.train.bc_train \
    --data rl/data/bc_classic.jsonl --epochs 10
"""
import argparse
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from gymnasium import spaces

from rl.train.network import ChoccusCNNExtractor
from rl.train.bc_dataset import BCDataset
from rl.env.constants import MAP_ROWS, MAP_COLS

N_ACTIONS = 6


def train_bc(
    data_path: str,
    output_path: str = 'rl/checkpoints/bc_extractor.pt',
    epochs: int = 10,
    batch_size: int = 512,
    lr: float = 1e-3,
    features_dim: int = 512,
) -> float:
    """Train BC model. Returns final epoch accuracy."""
    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })
    device = 'cuda' if torch.cuda.is_available() else 'cpu'

    extractor = ChoccusCNNExtractor(obs_space, features_dim=features_dim).to(device)
    head = nn.Linear(features_dim, N_ACTIONS).to(device)
    optimizer = torch.optim.Adam(
        list(extractor.parameters()) + list(head.parameters()), lr=lr
    )
    loss_fn = nn.CrossEntropyLoss()

    dataset = BCDataset(data_path)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=0)

    LOG_EVERY = 10  # print running stats every N batches

    print(f"Device: {device}  |  batch={batch_size}  |  epochs={epochs}", flush=True)
    t_start = time.time()
    final_acc = 0.0
    for epoch in range(epochs):
        total_loss = 0.0
        correct = 0
        total = 0

        for batch_idx, (grid, scalars, actions) in enumerate(loader, 1):
            grid    = grid.to(device)
            scalars = scalars.to(device)
            actions = actions.to(device)

            features = extractor({'grid': grid, 'scalars': scalars})
            logits   = head(features)
            loss     = loss_fn(logits, actions)

            optimizer.zero_grad()
            loss.backward()
            optimizer.step()

            total_loss += loss.item() * len(actions)
            correct    += (logits.argmax(1) == actions).sum().item()
            total      += len(actions)

            if batch_idx % LOG_EVERY == 0:
                running_acc = correct / total
                running_loss = total_loss / total
                elapsed = time.time() - t_start
                now = datetime.now().strftime('%H:%M:%S')
                print(f"[{now} +{elapsed:6.0f}s]  epoch {epoch + 1}/{epochs}"
                      f"  batch {batch_idx}"
                      f"  loss={running_loss:.4f}  acc={running_acc:.3f}",
                      flush=True)

        final_acc = correct / total if total > 0 else 0.0
        elapsed = time.time() - t_start
        now = datetime.now().strftime('%H:%M:%S')
        print(f"[{now} +{elapsed:6.0f}s]  BC epoch {epoch + 1}/{epochs}: "
              f"loss={total_loss / max(total, 1):.4f}  acc={final_acc:.3f}")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    torch.save(extractor.state_dict(), output_path)
    print(f"Saved extractor to {output_path}")
    return final_acc


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--data',   required=True)
    parser.add_argument('--out',    default='rl/checkpoints/bc_extractor.pt')
    parser.add_argument('--epochs', type=int,   default=10)
    parser.add_argument('--batch',  type=int,   default=512)
    parser.add_argument('--lr',     type=float, default=1e-3)
    args = parser.parse_args()
    train_bc(args.data, args.out, args.epochs, args.batch, args.lr)
