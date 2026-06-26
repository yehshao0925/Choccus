# RL Agent 設計規格：深度強化學習智能體開發與部署

**日期**：2026-06-26  
**目標**：訓練一個 PPO 智能體，在 solo/spectate 模式中對 v6:hunter 兩圖 CRN bench 勝率 ≥ 50%  
**基礎文件**：`docs/rl-plan.md`（原始構想）、`docs/ai-algorithm-survey-2026-06.md`（演算法調查）

---

## 核心約束

- **部署範圍**：solo / spectate 限定，不接入 lockstep 網路房。ONNX 浮點推論合法，不需 NNUE 整數化。
- **Python sim**：全保真移植（full-fidelity），不走 IPC 橋接。millitile 整數座標、Mulberry32 PRNG、lenient hitbox 全部對齊 TS 原版。
- **Ship gate**：RL bot 對 v6:hunter 的 CRN bench 勝率 ≥ 50%（classic 與 pirate 兩圖均需達標）。

---

## 整體架構（五階段）

```
Phase 0 │ Python sim 移植 + 轉移品質驗証（關卡）
        │   ↓ 通過才繼續
Phase 1 │ Gymnasium 環境（狀態空間 / 動作空間 / 獎勵函數）
        │   ↓
Phase 2 │ 神經網路 + 訓練流程（BC → 對戰 v6 → Elo 自我對抗）
        │   ↓
Phase 3 │ ONNX 匯出 + 瀏覽器部署（Web Worker 推論）
```

### 各層邊界

| 層 | 語言/環境 | 職責 |
|---|---|---|
| `rl/env/` | Python（NumPy） | 決定性整數 sim、Gymnasium API |
| `rl/train/` | Python（Stable-Baselines3 / PyTorch） | PPO 訓練、BC 預訓練、自我對抗 |
| `rl/export/` | Python（ONNX Runtime） | 模型匯出、量化、驗証 |
| `client/src/ai/rl/` | TypeScript | ONNX Runtime Web、Web Worker、`IBotController` 包裝 |

---

## Phase 0：Python Sim 移植規格（關卡）

這是整個系統的基礎。移植錯了，後面的訓練全都白費。

### 移植對照表

| TypeScript 原始檔 | Python 模組 | 關鍵細節 |
|---|---|---|
| `sim/Sim.ts` | `rl/env/sim.py` | tick 系統順序（1–10 步）不可重排 |
| `sim/Player.ts` | `rl/env/player.py` | int32 millitile 座標；corner assist；輸入緩衝 |
| `sim/Bomb.ts` | `rl/env/bomb.py` | 引信 180 ticks；放彈條件 |
| `sim/Explosion.ts` | `rl/env/explosion.py` | 十字射線；連鎖取最小引爆 tick；殘留 `[t, t+27)`；軟磚停格不殘留 |
| `sim/Shell.ts` | `rl/env/shell.py` | 困住 300 ticks；隊友碰=救援；敵人碰=直接淘汰 |
| `sim/SuddenDeath.ts` | `rl/env/sudden_death.py` | 7200 tick 起；每 18 tick 硬化一格；螺旋順序；純整數無亂數 |
| `sim/Map.ts` | `rl/env/map_gen.py` | 15×13；軟磚率 72%；出生角落淨空 3 格；Mulberry32 PRNG |
| `sim/Item.ts` | `rl/env/item.py` | 掉落率 50%；fire/speed/cannon 各 1/3 |
| `sim/Prng.ts` | `rl/env/prng.py` | Mulberry32；純整數 |
| `shared/constants.ts` | `rl/env/constants.py` | 所有數值的單一真實來源 |

### 移植三鐵則

1. **所有座標都是 int32 millitile**，不得轉成 float tile 座標再算。
2. **Explosion 射線邏輯必須逐字對齊** `sim/Explosion.ts`：連鎖爆炸取「最小引爆 tick」、殘留恰好是 `[t, t+27)`、軟磚那格爆炸後停止延伸（道具從那格掉落但火焰不過牆）。
3. **Lenient hitbox 必須實作** `explosionCovers` 的完整邏輯（見下節），不得用格心近似替代。

### Lenient Hitbox 實作規格

玩家被困住的條件是身體（1000×1000 millitile 矩形，中心在 posX, posY）被火焰格子覆蓋的**整數面積 ≥ 2/3**：

```python
def explosion_covers(cells, pos_x, pos_y):
    MILLITILE = 1000
    tx = round(pos_x / MILLITILE)
    ty = round(pos_y / MILLITILE)
    ox = pos_x - tx * MILLITILE  # [-500, +500]
    oy = pos_y - ty * MILLITILE
    sx = 1 if ox >= 0 else -1
    sy = 1 if oy >= 0 else -1
    area = 0
    for nx in [0, sx]:
        ovx = MILLITILE - abs(ox - nx * MILLITILE)
        if ovx <= 0:
            continue
        for ny in [0, sy]:
            ovy = MILLITILE - abs(oy - ny * MILLITILE)
            if ovy > 0 and explosion_at(cells, tx + nx, ty + ny):
                area += ovx * ovy
    # HIT_COVER_NUM=2, HIT_COVER_DEN=3
    return area * 3 >= 2 * MILLITILE * MILLITILE
```

這使 agent 能學到「偏心 > 1/3 格（> 333 mt）即可閃過火焰邊緣」的高階技巧（半身閃）。

### Phase 0 驗收標準（全過才放行）

| 測試 | 方法 | 門檻 |
|---|---|---|
| 決定性測試 | 同 seed 跑 100 局，Python vs TS 的每局勝負結果完全一致 | 100/100 |
| 轉移品質 | BC clone（對 v6 行為複製，10,000 局軌跡）在真實遊戲 CRN bench 對 v5:zoner 的勝率 | v6:hunter 基準值 ±8% 以內（基準值＝Phase 0 前先跑 `npm run v5-probe -- --target=v6:hunter --opponents=v5:zoner` 取得） |
| 效能 | 單核 SPS（每秒 sim 步數） | ≥ 10,000 SPS |

---

## Phase 1：Gymnasium 環境規格

### 狀態空間

**網格張量：15×13×12 通道**（修正原計畫的 11×11×8）

| 通道 | 內容 | 編碼方式 |
|---|---|---|
| 0 | 硬牆 | 0/1 |
| 1 | 軟磚 | 0/1 |
| 2 | 可推箱（pirate 地圖） | 0/1 |
| 3 | 自身位置 | 0/1（格心四捨五入） |
| 4 | 敵方位置 | 0/1（最多 3 敵） |
| 5 | 炸彈引信（歸一化） | `t_remaining / 180`（0 = 無炸彈） |
| 6 | 當前火焰危險格 | 0/1 |
| 7 | 預測危險格 | 0/1（所有在場炸彈的預測爆炸範圍，依現有火力） |
| 8 | 地面道具 | 1=火力 / 2=速度 / 3=炮數（歸一化 ÷3） |
| 9 | 突然死亡已硬化格 | 0/1 |
| 10 | 困住玩家位置 | 0/1 |
| 11 | 時間進度 | `tick / 10800`（全格填同一值） |

**純量特徵向量：9 維**（接在 CNN 輸出後）

```
[自身火力/7, 自身炮數/6, 自身速度加成/3, 已在場炸彈數/6,
 存活敵人數/3, 是否在突然死亡期(0/1), 推箱蓄力進度/30,
 self_ox, self_oy]
```

其中 `self_ox = (posX mod 1000 - 500) / 500`，`self_oy` 同理，範圍 [−1, +1]。這使 agent 能感知次格位移，進而學到 lenient hitbox 的閃彈技巧。由於移動不變量保證「至多一個軸偏心」，兩個值裡必有一個 ≈ 0。

### 動作空間

6 個離散動作：`{0:停止, 1:上, 2:下, 3:左, 4:右, 5:放炸彈}`

**硬性安全濾網（action mask）**：每步推論前，BFS 預判每個候選動作是否把自身帶入無安全逃生路徑的死胡同。若是，把該動作的 logit 設為 `-inf`。放彈動作須通過「放完後仍存在至少一條逃生路徑到視野內不致命格」的完整驗証，對齊 v6 的安全閘門邏輯。

### 獎勵函數

| 事件 | 獎勵 |
|---|---|
| 勝利 | +100 |
| 戰敗 / 被淘汰 | −100 |
| 擊殺敵方 | +30 |
| 炸毀軟磚 | +2 |
| 拾取道具 | +4 |
| 成功救援隊友 | +15 |
| 有效移動 | −0.05 |
| 無效動作 / 撞牆 | −0.2 |

**退火機制**：

$$R_t = R_{\text{sparse}} + \alpha^k \cdot R_{\text{dense}}, \quad \alpha = 0.9995$$

訓練初期 dense 獎勵主導引導探索；後期 $\alpha^k \to 0$，純靠勝負驅動，防止 agent 為刷磚獎勵而拒絕消滅對手。

---

## Phase 2：神經網路架構 + 訓練流程

### 網路架構

```
輸入: [15×13×12 網格] + [9 維純量向量]
         │
    ┌────▼────────────────────────────────┐
    │  CNN 特徵提取器                      │
    │  Conv2d(12→64,  3×3, pad=1) + ReLU  │
    │  Conv2d(64→128, 3×3, pad=1) + ReLU  │
    │  Conv2d(128→128,3×3, pad=1) + ReLU  │
    │  Flatten → Linear(128×15×13, 512)   │
    └────────────────────┬────────────────┘
                         │ concat 9 維純量
                    ┌────▼────┐
                    │  LSTM   │
                    │ hidden=256, layers=1
                    └────┬────┘
              ┌──────────┴──────────┐
         ┌────▼────┐           ┌────▼────┐
         │  Actor  │           │  Critic │
         │ 512→6   │           │ 512→1   │
         │softmax  │           │         │
         └─────────┘           └─────────┘
```

**參數量**：CNN ≈ 1.2M、LSTM ≈ 0.8M、頭部 ≈ 0.05M，總計約 2M 參數。

### 訓練課程（三階段）

**階段 2-A：行為複製預訓練（BC）**
- 收集 10,000 局 v6:hunter 自我對戰軌跡（用現有 TypeScript sim-runner 跑，存成 JSON）
- 監督式學習初始化 Actor（cross-entropy loss on actions）
- 驗收：BC clone 對 random agent 勝率 > 90%

**階段 2-B：對戰固定對手（漸進升級）**
- BC 初始化的 Actor → PPO fine-tune
- 對手順序：v3:trapper → v5:zoner → v6:hunter
- 每階段跑到勝率穩定 > 55% 再升級
- 採用 CRN（Common Random Numbers）確保進度可與現有 bench 數字直接比較

**階段 2-C：Elo 自我對抗**
- 維護 8 個歷史 checkpoint 的 policy pool
- 依 Elo 差距加權配對（接近強度的對手優先）
- 新 checkpoint 打贏 pool 中 > 50% 的對手才加入、末位淘汰
- Ship gate：RL bot 對 v6:hunter 的 CRN bench 勝率 ≥ 50%（兩圖均達標）

### PPO 超參數基線

| 參數 | 值 |
|---|---|
| rollout length | 512 steps per env |
| parallel envs | 64（目標 ~32,000 SPS） |
| epochs per update | 4 |
| clip ε | 0.2 |
| γ (discount) | 0.995 |
| GAE λ | 0.95 |
| entropy coeff | 0.01 → 0.001（線性衰減） |
| learning rate | 3e-4 → 1e-5（cosine decay） |
| LSTM sequence len | 64（BPTT 截斷長度） |

---

## Phase 3：ONNX 匯出 + 瀏覽器部署

### 匯出流程

```
PyTorch checkpoint (.pt)
        ↓ torch.onnx.export()
   model.onnx  （float32，含 LSTM h/c 顯式 I/O 節點）
        ↓ onnxruntime.quantize_dynamic()
   model_int8.ort  （INT8，推論用）
        ↓ 驗証：1,000 局 bench 勝率與原 PyTorch 偏差 < 1%
```

LSTM 的 hidden state（`h_0`, `c_0`）須設為**顯式輸入/輸出節點**，讓瀏覽器端每步傳入上一步的狀態。

### 瀏覽器架構（Web Worker 非同步推論）

```
main thread (60 Hz)
    │  每 tick 序列化 SimState → Float32Array
    │  postMessage → Web Worker
    ▼
[rl-worker.ts]
    ├── ONNX Runtime Web (wasm backend)
    ├── 維護 LSTM h/c state (Float32Array × 2)
    └── session.run() → postMessage { action, h1, c1 }
    │
    ▼
main thread 收到 action → 送進 InputBuffer
```

### TypeScript 包裝

```typescript
// client/src/ai/rl/RLBotController.ts
export class RLBotController implements IBotController {
  private pendingAction = 0;  // 上一幀 Worker 回傳的 action

  decide(state: SimState, slot: number): InputFrame {
    this.worker.postMessage(encodeState(state, slot));
    return actionToInputFrame(this.pendingAction);  // 1-tick 落後，可接受
  }
}
```

### 部署路徑

```
client/public/models/rl_bot_int8.ort
client/src/ai/rl/
  ├── RLBotController.ts
  ├── rl-worker.ts
  └── stateEncoder.ts     ← SimState → Float32Array（15×13×12 + 9 scalars）
```

### 效能驗收目標

| 指標 | 目標 |
|---|---|
| 單次推論時間 | < 5 ms（p99，含低階 Android） |
| 模型檔案大小 | < 10 MB |
| 初始化時間 | < 3 秒 |
| 記憶體占用 | < 100 MB（關閉 memory arena） |
| 主執行緒 FPS 影響 | ≤ 1 幀 |

---

## 與原計畫（docs/rl-plan.md）的主要差異

| 項目 | 原計畫 | 本規格 |
|---|---|---|
| 地圖尺寸 | 11×11（錯誤） | **15×13**（正確） |
| 狀態通道數 | 8 | **12**（新增突然死亡、困住、預測危險、推箱） |
| 次格位移 | 未設計 | **+2 scalar（self_ox, self_oy）**，支援 lenient hitbox 學習 |
| Hitbox 判定 | 未指定（隱含格心） | **完整 explosionCovers 面積計算** |
| 掉落率 | 30%（錯誤） | **50%**（`shared/constants.ts` 的真實值） |
| Phase 0 | 無 | **新增**：Python sim 轉移品質關卡，驗証才繼續 |
| 部署限制 | 未限定 | **solo/spectate 限定**，不接入 lockstep 網路房 |
