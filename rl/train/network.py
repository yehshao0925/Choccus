# rl/train/network.py
"""
CNN feature extractor for ChoccusEnv Dict observation space.
Processes 13×15×12 grid with CNN, concatenates 9 scalar features.
Output: `features_dim`-dim vector fed to LSTM in RecurrentPPO.
"""
import torch
import torch.nn as nn
from stable_baselines3.common.torch_layers import BaseFeaturesExtractor
import gymnasium as gym


class ChoccusCNNExtractor(BaseFeaturesExtractor):
    """
    Observation: Dict{
      'grid':    float32[13, 15, 12]  — 12-channel spatial map
      'scalars': float32[9]           — per-agent stats
    }
    Architecture:
      grid permuted (B,12,13,15) → Conv2d(12→64) → Conv2d(64→128) → Conv2d(128→128)
      → Flatten(24960) → concat scalars(9) → Linear(24969, features_dim) + ReLU
    """

    def __init__(self, observation_space: gym.spaces.Dict, features_dim: int = 512):
        super().__init__(observation_space, features_dim)

        n_channels = 12
        self.cnn = nn.Sequential(
            nn.Conv2d(n_channels, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(64, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Conv2d(128, 128, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.Flatten(),
        )
        # 128 filters × 13 rows × 15 cols = 24960
        cnn_out_dim = 128 * 13 * 15
        n_scalars = 9
        self.proj = nn.Sequential(
            nn.Linear(cnn_out_dim + n_scalars, features_dim),
            nn.ReLU(),
        )

    def forward(self, observations: dict) -> torch.Tensor:
        grid = observations['grid']           # (B, 13, 15, 12)
        grid = grid.permute(0, 3, 1, 2)      # (B, 12, 13, 15)
        cnn_out = self.cnn(grid.float())      # (B, 24960)
        scalars = observations['scalars'].float()  # (B, 9)
        combined = torch.cat([cnn_out, scalars], dim=1)
        return self.proj(combined)            # (B, features_dim)
