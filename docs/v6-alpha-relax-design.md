# v6 設計：α-relax opponent-model-in-search（restricted-Nash 軟混合）

> 2026-06-22。`docs/ai-algorithm-survey-2026-06.md` §6 結論的唯一「有理論依據、尚未做對」的 bot 層槓桿。
> 目標：把 v5 過度保守的 maximin 安全評估，**按對手實際是否會懲罰**做**有界**放鬆，捕回現在白讓的進攻價值。
> 對症 v5 天花板＝「所有進攻槓桿被封鎖鏡像讓掉」。設計鐵則：決定性整數、lockstep、硬閘門不動、可對未知對手。

## 1. 過度保守在哪（grounded in code）

- 搜尋是**單人**前向模型（只動我方），對手**全部編碼在 `scenarios`（danger map）**裡。
  `evalLeaf`（`v5/core/forwardSearch.ts:210`）：`worstSurv = MIN over 3 scenarios`（maximin）。
- `buildScenarios`（`v5/core/scenarios.ts`）**已經**做了「現實過濾」：只對 **(a) BFS 距離 ≤ foeReachTiles**
  且 **(b) 有空炮**（`p.activeBombs < p.cannon`，line 60）的敵人疊壓力彈。
  → **`gap = optSurv − worstSurv > 0` 只在「有空炮的近敵」存在時發生**；遠敵/沒空炮的敵人 maximin 早已不咬。
- 故**殘存的過度保守是「行為層」**：對一個「有空炮的近敵」，maximin **假設它一定會封殺**——
  但若這敵人行為上是**發育流（farmer，近但在農田、不封人）**，這個假設是錯的、白白砍掉我方的進攻線。
  這正是「進攻槓桿被 trapper 讓掉」的根因：**maximin 把每個近敵都當 trapper**。

## 2. 機制：evalLeaf 的 α-relax 混合

把 `evalLeaf` 的安全項由 maximin 改成「worst 往 optimistic 混合，混合量 = α × slack × gap」：

```
optSurv   = survivability(scenarios[0])          // 樂觀 baseline（cache 已有，零額外成本）
worstSurv = MIN over scenarios                     // 不變
gap       = optSurv - worstSurv                     // ≥ 0；>0 ⟺ 有空炮近敵能封我
relaxed   = worstSurv + floor(relaxAlpha * slack * gap / 65536)   // α,slack ∈ [0,256]
leafVal   = W_SURVIVE * min(relaxed, survEnough) + accReward - penalty
```

- **`relaxAlpha`**＝per-map 常數旋鈕（restricted-Nash 的「信任度／安全撥盤」）。**0 ＝ gap×0 ＝ relaxed=worstSurv ＝ 逐位元 v5。**
- **`slack`**＝per-leaf 行為信號 ∈[0,256]：「這顆近敵有多不可能真的封我」。
  - **Probe 0（無狀態）**：`slack=256` 常數 → `relaxed = worstSurv + floor(relaxAlpha*gap/256)`（全面放鬆）。
  - **Probe 1（行為條件化）**：`slack = max(0, 256 − k·foeSealRate)`，只對**實測非封殺者**放鬆。
- restricted-Nash 性質：可剝削性（對最壞對手的損失）被 α 上界 → **對未知/人類不脆**（α 小＝下行小）。
  這是用「連續混合」取代 adaptDefense 的「on/off 硬切」——§6 ③ 診斷出的閃爍死因被結構性消掉（monotone-in-VALUE）。

## 3. 安全 / 決定性分析（為何下行有界）

- **硬閘門全不動**：`moveLegal` 用的是 **scenario0（已是樂觀）**（forwardSearch.ts:142）；`bombGateOk` 用悲觀。
  → α **只重排 gate-legal 動作間的位置偏好**，**不能**讓 bot 自殺放彈、也不能走進「樂觀下也會死」的格。
  下行＝「站到一個只有敵人不封才安全的格」，且被 α 上界——與 `entrapWeight`/`shrinkWeight` 同層（只重排安全格）。
- `relaxed ≥ worstSurv`（gap≥0）→ 只會**升**安全估值（＝**降**戒心）。這是刻意的風險，硬地板封住真危險。
- **整數**：floor/＋/－/×；gap≥0；量級 `α·slack·gap ≤ 256·256·~50 ≈ 3.3M / 65536 ≈ 50`，`W_SURVIVE·50 = 5e4`，
  遠在 safe-integer 內。**無 RNG / Date / sqrt**。`survEnough` clamp 保留。

## 4. 分階段（由快到慢，只在有訊號才升級）

### Probe 0 — 無狀態全面放鬆（最便宜，~offEntrap 等級）
- 改動：SearchKnobs 加 `relaxAlpha`；evalLeaf 混合（slack 寫死 256）；MapProfile 加 `relaxAlpha:0`；
  BotController knobs 物件加 `relaxAlpha: profile.relaxAlpha`。
- 跑 `v5-screen` 掃 `relaxAlpha ∈ {32,64,128}`，兩圖，對手＝**[v4:zoner, v3:trapper, v3:farmer, v3:noise]**。
- **判讀＝逐對手 DIAGNOSTIC split，不是只看 aggregate 判定**：
  - 預期 **farmer ↑、trapper/v4 ↓**（全面放鬆＝又一條被鏡像讓掉的 attack lever，ship-gate 大概 DROP）。
  - **farmer 真的 ↑ ＝「行為可剝削價值存在」→ 進 Probe 1**（去條件化、只留 farmer 那段上行）。
  - 連 farmer 都不漲（純 wash）→ **方向死、DROP**，跟 §6 收工一致。

### Probe 1 — 行為條件化（真正的 v6 機制）
- 加**每敵 sealRate**（跨 tick、決定性整數）：每決策 tick 更新 `foeSealRate[slot]`
  ＝該敵「在交戰距內放彈」的平滑率（整數 EWMA，例 `rate += (event*256 − rate) >> 4`）。封殺者高、農夫低。
- evalLeaf 的 slack 改 `cb.relaxSlack(leafTile)` ＝ `max(0, 256 − k·sealRate(最近敵))`（最近敵用每決策一張
  enemy-distance BFS field，O(1) 查）。→ 只對**實測非封殺者**放鬆。
- 重跑 Probe 0 的 screen。**過關＝farmer 上行保留、且 v4 / trapper / noise 皆 not-worse。**

### 完整評估（僅 Probe 1 過關才做）
- 複製 `v5/ → v6/`，鎖定每圖最佳 `relaxAlpha`/`k`，跑 `bt-rank`（兩圖）＋ `meta-rank` ＋ `npm test` ＋ `npm run lint`。
- 出貨判準（同 repo）：對現役冠軍 `v5:zoner` 兩圖直接 CRN ≥ 50%，且 noise not-worse。

## 5. 反過擬合（panel 集體盲點，必守）
- screen **一定要含池外、風格刻意不同的 `v3:noise`**，且要求 **not-worse**。
  只贏已知 roster（farmer/trapper）＝過擬合假陽性。
- 模型**只用物理/行為量**（距離、空炮、sealRate）——**禁 archetype 分類器**（只認識 roster、對人類必崩）。

## 6. 風險 / 還原
- `relaxAlpha:0` ＝逐位元 v5；還原＝`git checkout`（同 offEntrap 流程）。
- 主風險：放鬆安全＝對真封殺者多死——由 α 上界 + Probe 1 行為條件化 + noise gate 三重防。
- Probe 0/1 都在 v5 上 flag-gated（default 0）跑；確定出貨才複製 v6/。

---

## 7. Probe 0 實測結果（2026-06-22）— **淨中性、未出貨、已還原**

實作了 Probe 0（無狀態 blanket，`relaxAlpha` 旋鈕，default 0 = 逐位元 v5），跑 `v5-screen`（paired CRN，
4 對手含池外 `v3:noise`）＋ 權威 `bt-rank`（pirate 全池 720 場，`--no-write`）：

- **screen（pirate, α=64/128）**：farmer **+4~5%**，v4 / trapper / **noise 全 flat** → 看似乾淨無下行；
  但 z 只 ~0.7（48 reps 仍未過 1.5 顯著門檻）。classic α=64 ＝ v4 −2.1 / trapper +2.1，mild wash。
- **bt-rank（pirate, α=64）決定性打臉**：refit **Elo = 1805，和 committed 一模一樣**。逐對手顯示
  farmer 57→**61（+4）**被 **v3:zoner 64→57（−7）抵掉** → **淨 Elo 0**。screen 之所以看起來乾淨，
  是它測了 trapper（flat）卻**沒測 v3:zoner**——而 v3:zoner 正是會懲罰過度延伸的控場型。
- **結論**：blanket α-relax ＝又一條「對不懲罰者賺、對控場者賠、washes」的 conceded-lever（§六同型）。
  **不出貨。** Probe 1（行為條件化只對非封殺者放鬆）理論上能留 farmer+ 收 zoner−，但天花板低（~+4%）
  且是較大建置——**未建**。working tree 已 `git checkout` 還原回逐位元 committed v5。

> 總帳：這是繼 offEntrap（掉 v4）之後**第三次**實證 v5 在 bot 層天花板。`docs/ai-algorithm-survey-2026-06.md`
> §6 的「唯一未做對的 opponent-model-in-search」經 Probe 0 證實 blanket 版淨零；要翻盤只剩 Probe 1
> 條件化（低天花板大建置）或改 sim。
