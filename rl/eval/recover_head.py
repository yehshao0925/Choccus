# rl/eval/recover_head.py
"""
舊格式 checkpoint（只有 extractor）補訓 head，存成新格式（extractor + head）。

Usage:
  rl/.venv/bin/python -m rl.eval.recover_head \
    --ckpt rl/checkpoints/bc_extractor_classic_ep4.pt \
    --data rl/data/bc_classic.jsonl \
    --out  rl/checkpoints/bc_extractor_classic_ep4_full.pt \
    --batches 300
"""
import argparse
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from gymnasium import spaces
from torch.utils.data import DataLoader

from rl.env.constants import MAP_ROWS, MAP_COLS
from rl.train.bc_dataset import BCDataset
from rl.train.network import ChoccusCNNExtractor


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--ckpt',    required=True, help='舊格式 .pt 路徑')
    parser.add_argument('--data',    required=True, help='JSONL 訓練資料')
    parser.add_argument('--out',     required=True, help='輸出新格式 .pt 路徑')
    parser.add_argument('--batches', type=int, default=300, help='head 補訓 batch 數')
    args = parser.parse_args()

    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f"Device: {device}")

    obs_space = spaces.Dict({
        'grid':    spaces.Box(-1.0, 1.0, (MAP_ROWS, MAP_COLS, 12), np.float32),
        'scalars': spaces.Box(-1.0, 1.0, (9,), np.float32),
    })

    raw = torch.load(args.ckpt, map_location=device)
    if isinstance(raw, dict) and 'extractor' in raw and 'head' in raw:
        print("已是新格式，直接複製到輸出路徑。")
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        torch.save(raw, args.out)
        return

    extractor = ChoccusCNNExtractor(obs_space, features_dim=512).to(device)
    state_dict = raw if isinstance(raw, dict) else raw
    extractor.load_state_dict(state_dict)
    extractor.eval()
    for p in extractor.parameters():
        p.requires_grad_(False)
    print(f"Extractor 載入完成（{args.ckpt}），開始補訓 head…")

    head = nn.Linear(512, 6).to(device)
    optimizer = torch.optim.Adam(head.parameters(), lr=1e-3)
    loss_fn = nn.CrossEntropyLoss()

    loader = DataLoader(
        BCDataset(args.data),
        batch_size=512, shuffle=False, num_workers=0,
    )

    for i, (grid, scalars, actions) in enumerate(loader):
        if i >= args.batches:
            break
        with torch.no_grad():
            feats = extractor({'grid': grid.to(device), 'scalars': scalars.to(device)})
        logits = head(feats)
        loss = loss_fn(logits, actions.to(device))
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        if (i + 1) % 50 == 0:
            acc = (logits.argmax(1) == actions.to(device)).float().mean()
            print(f"  batch {i+1:3d}/{args.batches}  loss={loss.item():.4f}  acc={acc:.3f}")

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    torch.save({
        'extractor':    extractor.state_dict(),
        'head':         head.state_dict(),
        'features_dim': 512,
        'epoch':        4,
    }, args.out)
    print(f"儲存完成 → {args.out}")


if __name__ == '__main__':
    main()
