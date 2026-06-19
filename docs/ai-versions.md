# AI 版本狀態（Choccus Bot）

> 最後更新：2026-06-19
> 評估工具：`tools/sim-runner/` 的 `matrix-bench`（1v1 勝率矩陣，判每圖冠軍）、`version-bench`（活 bot vs 凍結前一版）。

## 目前各地圖冠軍（matrix-bench rank-1）

| 地圖 | 目前冠軍 | 勝率 | 是 v2？ |
| --- | --- | --- | --- |
| **pirate**（開放） | **v2-Aggressor** | 69.3% | ✅ |
| **classic**（封閉） | **v2-Chaosv**（co-leader v2-Aggressor 60.7%） | 66.4% | ✅ |

> 目標(`/goal`):**兩圖 rank-1 都是 v2 策略** → **已達成（2026-06-19）**。classic 由
> `deferredBombDiscountPct=100`（只有當下放的彈才算搜尋 reward）治好 defer-forever 退化，
> 四個 v2 archetype 整體勝率全壓過四個 v1（見第三、四節）。

## 一、版本登錄表

| 版本 | 狀態 | 核心架構（一句話） | 程式位置 |
| --- | --- | --- | --- |
| **v1** | 凍結（baseline） | 單層加權評分迴圈，**貪婪 1-ply**（只評當下 6 個候選） | `client/src/ai/v1/` |
| **v2** | **最新 / live**（`AI_VERSION = 2`） | v1 的評分項 + **depth-4 forward-search maximin**（3 個悲觀場景）；**核心引擎與地圖策略解耦** | `client/src/ai/v2/`（`core/` + `classic/` + `pirate/`） |

- 兩版各自是獨立、可並存的決策碼快照；版本本身就是持久化機制（無另存的 frozen baseline）。
- **v2 地圖分軌（2026-06-19）**：v2 的決策引擎抽進 `client/src/ai/v2/core/`（`forwardSearch` / `scenarios` / `commitment`，map-agnostic），每張地圖的策略旋鈕收斂成一個 `MapProfile`（`client/src/ai/v2/{classic,pirate}/MapProfile.ts`，介面在 `v2/MapProfile.ts`）。`BotController` 依 `SimState.mapKind`（新增的非 hash 比賽常數）在第一次 `sample()` 選定 profile 並快取。**仍是同一個 `AI_VERSION = 2`、同一份註冊表**——classic/pirate 只是同版內依地圖派發的兩組策略，不是兩個版本。目前兩 profile 數值相同（== committed v2，純結構重構，行為與 matrix-bench 逐字未變）；之後各圖各自調 profile 即可，不互相影響。
- 共用感知層在 `client/src/ai/common/`（危險圖 `dangerMap`、BFS、爆炸射線等，逐字對齊 sim 的 `Explosion.ts`）。
- 兩版共用同一組 4 個策略 archetype：**Aggressor / Turtle / Gambler / ChaosV**（旋鈕在各自的 `BotConfig.ts` / `Strategies.ts`）。
- 決定性契約（兩版皆守）：純函式 `(自帶 RNG, SimState) → InputFrame`；禁 `Math.random / Date.now / performance.now / Math.sqrt / sin / cos`；整數評分、固定候選順序、strict `>` 平手取第一。可用於連線房 lockstep 補位。

## 二、各版本說明

### v1（凍結 baseline）
- **決策**：每個 decision tick 列舉固定候選 `[STAY, UP, DOWN, LEFT, RIGHT, PLACE_BOMB]`,以單一整數加權和
  `score = W_SURVIVE·survivability + W_RESCUE·rescue + W_ATTACK(state)·pressure + W_ECON·economy + W_POSITION·position`
  取最高。「防守／獵殺／發育」行為由連續的 attack 權重**自然湧現**,無模式切換。
- **無前瞻**:只看「這一步」的結果格,不做多步模擬。
- **檔案**:`BotController.ts`、`BotConfig.ts`、`Strategies.ts`、`module.ts`。
- **定位**:對照基準。日後改 AI 一律升版,不回頭改 v1。

### v2（最新 / live）
- **在 v1 之上加上前瞻搜尋**:`forwardSearch.ts` 跑 depth-4 DFS,用 bot 私有的輕量前向模型(不呼叫真 `tick()`,不碰 `SimState.prng`)。
- **悲觀 maximin**:`scenarios.ts` 疊出 3 張危險圖(baseline / 對手施壓彈 / 封堵逃生道),survivability 取 3 場景**最小**(對最壞情況穩健),reward 對 baseline(場景 0)算。root 動作分數取「自己後續分支的 MAX」。
- **硬性放彈閘門**:`computeBombGateOk` / `validateBombRefugePessimistic` — 放彈前必須存在「我方彈 + 鄰近敵彈」下仍可達的逃生格,否則該放彈動作淘汰。
- **引擎檔案（map-agnostic）**:`core/forwardSearch.ts`、`core/scenarios.ts`、`core/commitment.ts`(目標承諾 / 反抖動)。
- **地圖策略**:`MapProfile`(目前 4 個旋鈕,皆中性 == committed v2):`deferredBombDiscountPct`(延後放彈的深度折扣)、`stayPenalty`(STAY 罰分)、`survEnough`(survivability clamp)、`deadlockGrowthRelease`(原地彈被閘門否決時解除 growth 抑制,治出生角死鎖)。要新增 per-map 行為就擴充此介面 + 兩個 profile 實例,`core/` 不動。
- **定位**:當前 live 版本。要演進(換引擎)時複製成 `v3/`,不在原地重寫;**只調某張圖的策略則改該圖的 `MapProfile`**。

## 三、目前強度（matrix-bench，8 agent 1v1 round-robin，每圖各 280 場）

每圖把 v1 四 archetype + v2 四 archetype 共 8 個放進 1v1 循環賽,以整體勝率排名,**rank-1 即該圖冠軍**。

### pirate（開放圖）— ✅ 冠軍已是 v2
| 名次 | agent | 整體勝率 |
| --- | --- | --- |
| **1** | **v2-Aggressor** | 69.3% |
| 2 | v2-Chaosv | 65.0% |
| 3 | v1-Gambler | 59.3% |
| 4–5 | v2-Turtle / v2-Gambler | 53.6% / 49.3% |
| 6–8 | v1-Aggressor / v1-Turtle / v1-Chaosv | 33.6–36.4% |

→ v2 的前瞻在開放圖全面壓制 v1(多數對位 60–90%)。

### classic（封閉圖）— ✅ 冠軍已是 v2（2026-06-19 翻轉）
| 名次 | agent | 整體勝率 |
| --- | --- | --- |
| **1** | **v2-Chaosv** | 66.4% |
| **2** | **v2-Aggressor** | 60.7% |
| 3 | v1-Gambler | 50.7% |
| 4 | v2-Gambler | 50.0% |
| 5 | v2-Turtle | 45.7% |
| 6–8 | v1-Turtle / v1-Aggressor / v1-Chaosv | 45.0 / 40.7 / 40.7% |

→ classic profile 開 `deferredBombDiscountPct=100` + `deadlockGrowthRelease` 後，v2 由
包辦後四名翻成包辦前二（repeats=15 確認：四個 v2 整體勝率全壓過四個 v1）。verdict 為
「co-leaders v2-Chaosv & v2-Aggressor」（兩者 h2h 50%，但都是 v2 → rank-1 屬 v2，達標）。

## 四、classic 凍結問題（✅ 已解決 2026-06-19）

### 問題:v2 在 classic（封閉圖）凍結、不發育
classic 1v1 幾乎**沒有人被炸死**(都打到 tick cap),勝負由「道具發育數」tiebreak 決定 → classic 是純**發育競賽**。v2 在 classic 發育停滯(常停在初始火力 2 / 炮 1),被 v1 在道具數上拖死。

### 根因(已定位,2026-06-19)
病根**不是**安全判讀不準,而是決策邏輯對「正確的不安全判讀」缺乏應變,造成兩種凍結:

1. **出生角死鎖**:classic 出生角是 L 形 3 格淨空 pocket,四周是磚。fire-2 彈的十字會蓋住整個 pocket → 真的無逃生路 → 閘門**正確**否決原地放彈。但「腳下有磚 → 別亂走,留下來炸」的 growth 抑制規則仍生效 → bot 想原地炸卻炸不了、又被禁止移動 → 卡死在出生角。
2. **「延後一樣好」退化(defer-forever)**:forward-search 對 root 取「自己後續分支的 MAX」。STAY 一格後仍能到達跟「現在行動」幾乎相同的好 leaf → STAY 與行動打平 → 第一順位 STAY 取勝 → bot 傾向永遠不動。實測 classic 上 STAY 佔 ~85–93% 的決策、放彈僅 0.1–0.2%。

> 關鍵佐證:把安全權重壓到近乎二元(clamp),bot 決策**完全不變** → 確認凍結與安全評分高低無關,而是上述決策結構問題。資訊面無缺(bot 已能讀整張地圖、所有炸彈/道具、以及**對手的火力/炮數/速度/座標**並用於悲觀場景),瓶頸在「怎麼用」而非「看不看得到」。

### 修法與進度
**第一步(已完成,2026-06-19):地圖分軌結構**。把 v2 拆成 `core/` + 每圖 `MapProfile`(見第一節),classic/pirate 從此各調各的、互不影響。純結構重構,行為與 matrix-bench 逐字未變(pirate 仍冠軍、classic 仍待修),作為後續調參的乾淨地基。

**第二步(已完成,2026-06-19):掃定 classic 的 `MapProfile`**。用 `tools/sim-runner/src/sweep-classic.ts`（classic-only 8-agent 1v1 循環賽，注入候選 classic profile 到 v2 bot；對 neutral 候選與 matrix-bench classic 逐字相符）對三個 anti-defer 旋鈕做 1-D 敏感度掃描（repeats=5 粗掃 → repeats=15 確認）：
- **`deferredBombDiscountPct` = 100（決勝旋鈕）**:depth d 放的彈只保留 `max(0,100−100·d)%` reward → 只有「當下(root/depth-0)放的彈」算 reward、所有延後彈一律 0 reward → 直接殺掉 defer-forever，bot 改以放彈 tempo 發育。掃描 0→100 單調變強，70–100 為「v2 全包 classic 前四」的穩定 plateau，100 最強（rank-1 v2-Chaosv 66.4%、co-leader v2-Aggressor 60.7%）。
- **`deadlockGrowthRelease` = true（保留）**:原地彈被閘門否決時解除 growth 抑制 → 治出生角死鎖。與 disc 正交，續開。
- **`stayPenalty` / `survEnough`（掃過，維持中性）**:survEnough 在封閉圖完全不咬（安全分高低不翻 argmax）；flat STAY penalty 反而弄弱其他 v2 archetype。皆留 0 / MAX。
- **escape-space squeeze 進攻項**:未採用（disc 已足夠奪冠）；實驗碼仍存於 `docs/wip/classic-fix-experiment.patch`，日後若要進一步拉開可再評估。

> 目標達成:`matrix-bench` 中 **classic 與 pirate 兩圖 rank-1 都屬 v2**。因已分軌、pirate profile 維持中性，pirate 冠軍（v2-Aggressor 69.3%）逐位元未變。
>
> 註:`version-bench`（4-bot FFA）classic 上 v2 與凍結 v1 仍互有勝負（1v1 發育賽與 4-FFA 獎勵略不同），非達標指標；如日後要 4-FFA 也更強，可再微調 disc 或評估 squeeze 項。

## 五、如何重跑評估

```bash
cd tools/sim-runner
npm run matrix-bench      # 8 agent 1v1 勝率矩陣,印每圖排名+冠軍(預設 v1 vs v2)
npm run version-bench     # 活 bot vs 凍結前一版,4-bot FFA,兩圖,看 ΔWinRate
```

- 判定目標達成的條件:`matrix-bench` 輸出中 **classic 與 pirate 兩圖的 rank-1 都屬於 v2**。
