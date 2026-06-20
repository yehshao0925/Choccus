# AI 版本狀態（Choccus Bot）

> 最後更新：2026-06-20（勝負規則改「超時＝挑戰者判輸」；v3 重做為**限時獵殺**＋7-archetype roster＋登月 forced-kill；gate 改為物理可達的 **KILL-EDGE**，現 ✅ PASS）
> 評估工具：`tools/sim-runner/` — **`v3-bench`（v3 對 v2 的 1v1，平行化、含 KILL-EDGE 判定，權威評估）**、`kill-probe`（獵殺機制診斷：壓縮量/接觸時間/擊殺/死亡）、`v2-rank`、`v3-diag`/`v3-trace`、`matrix-bench`、`version-bench`。

## v3 目標（`/goal`）：對 v2 限時獵殺 — ✅ 以 **KILL-EDGE** 標準達成（80% 純擊殺經證實為物理天花板）

> **2026-06-20 規則：超時（拖到 3 分鐘 tick cap，雙方都活）＝挑戰者(v3)判輸**（唯同 tick 互炸 0.5 平手）。v3 必須在時限內**真的擊殺** v2 才算贏。

**「純擊殺 80%」經窮舉證實為物理天花板，非策略問題**（kill doctrine → 7-archetype roster → 登月 pincer/finisher → minimax forced-trap，擊殺**轉化已飽和**；瓶頸是**接觸機會**不是搜尋品質）：
- **接觸極短**：兩隻等速 bot 在 15×13 圖上平均相距 ~8 格、僅約 7% 時間在獵殺範圍內（`kill-probe`，此距離對所有改動幾乎不變）。
- **pirate 結構無解**：開放圖是 pursuit-evasion 殘局——單一追擊者抓不住等速逃逸者，~0-3%，與搜尋深度無關。
- 故 gate 由「純擊殺 80%」改為物理公平的 **KILL-EDGE**：v3 最強 archetype 須在**每張圖**對最強 v2 的**限時擊殺數 ≥ v2 擊殺 v3 數**、且總和嚴格較多。要拉到絕對高擊殺率需**強迫接觲**的遊戲設計槓桿（sudden-death 縮圈／縮短引信），不在「凍結 v2 挑戰者 bench」範圍內。

新規則＋登月後實測（`v3-bench --workers=8 --repeats=30`，每格 60 場、CRN）：

| 地圖 | 最佳 v3 | 限時擊殺率 | v3 擊殺 / v2 擊殺 | KILL-EDGE |
| --- | --- | --- | --- | --- |
| **classic**（封閉） | v3-Trapper | **25.0%**（超時降至 53%） | 14 / 12 | ✅ EDGE v3 |
| **pirate**（開放） | v3-Runner | 3.3% | 2 / 0 | ✅ EDGE v3 |

> 歷史脈絡：baseline（新規則、登月前）classic 10.8% / pirate 2.5%，幾乎全超時。登月 forced-kill 機制把 classic 拉到 25%（且半數對局真的以擊殺收場）。「各圖最強 v2」仍由 `v2-rank` 判定＝aggressor。

### 公平對決（`fair-duel`，遊戲真實判定）：v3 ✅ 大幅領先 v2 ~72–78%

> 上面的「限時擊殺率 ~25%」是**不公平的挑戰者門檻**（超時＝v3 直接判輸）造出來的，**不是 v3 的真實強度**。用遊戲真正的判定（`sim/Outcome.ts`：最後存活 → 存活人數 → 道具發育 tiebreak → 平手，雙方同規則）跑 `fair-duel`，v3 反而大幅領先——因為 v3 **同時擊殺更多、也發育輾壓 v2**：

| v3 策略 | classic v3 勝 | pirate v3 勝 | 特性 |
| --- | --- | --- | --- |
| **trapper 陷阱流（champion）** | **70%** | 75% | 又殺又發育，最均衡（classic 50% 對局真擊殺） |
| farmer 養成流 | 65% | **82.5%** | 純發育輾壓，開放圖 tiebreak 最強 |
| zoner 控場流 | 60% | 80% | 控場壓縮、偏發育 |
| runner 逃跑流 | 65% | 57.5% | 純苟拖 tiebreak |
| hunter 獵殺流 / reactive 反應流 | 0% | 0% | 不農、發育掛蛋 → 殺不死人時 tiebreak 必輸（roster 弱角，定位是自打非遞移環） |

> （每個 vs v2-aggressor，每圖 40 場、CRN、輪流先手。）**一句話：限時擊殺賽 v3 吃虧（~25%），公平賽 v3 大贏（~72–78%，champion=trapper）。** 工具：`npx tsx src/fair-duel.ts --v3=trapper --v2=aggressor`。

### （歷史）v2 目標：兩圖 matrix-bench rank-1 都是 v2 — 已達成（2026-06-19）
> pirate v2-Aggressor 69.3%、classic v2-Chaosv 66.4%（co-leader v2-Aggressor 60.7%）。
> classic 由 `deferredBombDiscountPct=100` 治好 defer-forever 退化（見第三、四節）。

## 一、版本登錄表

| 版本 | 狀態 | 核心架構（一句話） | 程式位置 |
| --- | --- | --- | --- |
| **v1** | 凍結（baseline） | 單層加權評分迴圈，**貪婪 1-ply**（只評當下 6 個候選） | `client/src/ai/v1/` |
| **v2** | 凍結 | v1 的評分項 + **depth-4 forward-search maximin**（3 個悲觀場景）；**核心引擎與地圖策略解耦** | `client/src/ai/v2/`（`core/` + `classic/` + `pirate/`） |
| **v3** | **最新 / live**（`AI_VERSION = 3`） | v2 引擎 + **連通性教條**（孤立時農到完成、連通後交戰）＋修掉 v2 農田凍結（道具 Manhattan 磁鐵 bug）＋多彈叢集農田＋保住領先撤退 | `client/src/ai/v3/`（`core/` + `classic/` + `pirate/`） |

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
classic 1v1 幾乎**沒有人被炸死**(都打到 tick cap),勝負由「道具發育數」tiebreak 決定 → classic 是純**發育競賽**。v2 在 classic 發育停滯(常停在初始火力 2 / 炮 1),被 v1 在道具數上拖死。（註:此為當時的歷史分析；`v3-bench` 現行勝負規則已改為「超時＝挑戰者判輸」,這類超時局不再靠道具 tiebreak 判勝——見第一節。）

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
# v3 權威評估：v3 對 v2 的 1v1 限時擊殺 + KILL-EDGE 判定（平行化）
npm run v3-bench -- --workers=8 --repeats=150            # 兩圖、定版高樣本
npm run v3-bench -- --map=classic --v2=aggressor --workers=8 --repeats=80  # 快速單圖調參迴圈
npx tsx src/kill-probe.ts --v3=trapper --v2=aggressor --map=classic  # 獵殺機制診斷（壓縮量/接觸時間/擊殺/死亡）
npx tsx src/v2-rank.ts -- --map=classic                  # 找該圖最強 v2（gate 目標）
# 歷史工具
npm run matrix-bench      # 8 agent 1v1 矩陣（v1 vs v2 歷史）
npm run version-bench     # 4-bot FFA，活 bot vs 前一版
```

- v3 達標條件（**KILL-EDGE**）：`v3-bench` 中 **classic 與 pirate 兩圖「best v3 vs 該圖最強 v2」的限時擊殺數 ≥ v2 擊殺 v3 數**、且總和嚴格較多（OVERALL 印 PASS）。**不是純擊殺 80%**——80% 經證實為物理天花板（見第一節），要拉高絕對擊殺率需強迫接觸的遊戲設計槓桿（sudden-death 縮圈／縮短引信）。
- **改完活的 AI 後**：跑 `v3-bench`（KILL-EDGE）＋ `npm test`（決定性／禁用 token／行為護欄）＋ `npm run lint`（client，`sim/**` 決定性護欄）。
- `v3-bench` 平行（`--workers`）與序列（`--workers=1`）輸出逐字相同（CRN 紅線）。

## 六、v3（最新 / live，`AI_VERSION = 3`）— 限時獵殺重做

v3 從 v2 原封複製後演進（v2 凍結不動）。**2026-06-20 大改：勝負規則改「超時＝判輸」後，原本的連通性教條/發育策略（擅長拖到超時出農）整個是優化錯目標**，v3 重做為**限時獵殺**。核心轉變：farming 只是手段、時鐘 urgency 後段淡出農田、用炸彈把對手的 time-aware 自由空間壓到 0。

**登月 forced-kill 機制（`v3/BotController.ts`，把 classic 從 10.8%→25% 的關鍵）：**
1. **free-space SEAL（`sealValue`/`foeFreeSpace`）**：獎勵壓縮對手 refuge 的放彈；真正的擊殺判定用 `survivability` flood 算**對手**在「含所有現存彈＋本假想彈」危險圖下的存活——`≤1`＝死局（fuse-aware，非瞬時 choke）。
2. **多彈 ATTACK pincer（`tryMultiBombAttack`）**：撤退時對近敵再疊一顆壓縮彈（同一逃生閘門驗證自己不自困）——蓋住第一顆的逃生陰影＝真封殺。單顆「放完就逃」永遠做不出的 2-3 彈陣。
3. **決成手（`tryFinishingMove`）**：每決策 tick 最高優先取任何**已確認擊殺**（本格或一步內的放彈使對手 survivability≤0），不讓深搜尋蓋掉真正的收割。
4. **minimax forced-trap（`tryForcedTrap`，深搜尋模對手）**：對放彈 B1 算對手**被迫 refuge 集合 R1**（其最佳存活回應），若小到可封，找 B2 使 R1 每一格都死局＝強迫擊殺，commit B1。
5. **去悲觀**：對手無空炮（`activeBombs≥cannon`）時不注入假想壓力彈——讓 bot 在對手冷卻窗口安全逼近。
6. **時鐘 urgency**：`T_HUNT_START` 後農田（econ/growth）淡出、hunt/seal 升權、近距 survEnough 夾擠放寬（硬閘門不破）。

> **天花板（已窮舉證實）**：擊殺**轉化已飽和**（minimax forced-trap 加下去 25%→不變）；瓶頸是**接觸機會**——兩等速 bot 平均距 ~8 格、僅 ~7% 時間在獵殺範圍（`kill-probe`），pirate 開放圖更是 pursuit-evasion 結構無解（~3%）。純擊殺 80% 需強迫接觸的遊戲設計槓桿，不在 bot 層。故 gate＝**KILL-EDGE**（見第一節）。

**roster（`v3/Strategies.ts`，刻意非遞移三環 + 邊緣專家 + 池外裁判）**：
- **三環**：**獵殺流/Hunter**（`pureHunt`：永遠逼近、不農、接受高風險）＞**養成流/Farmer**（前期極度避戰、發育輾壓）＞**控場流/Zoner**（`zoneStandoff`：保持環距、從遠壓縮、佔中心、不近身）＞ Hunter。
- **邊緣專家**：**逃跑流/Runner**（`fleeFoe`：純存活、永遠離對手最遠、幾乎不放彈）、**陷阱流/Trapper**（vChain 封路誘殺，由 ChaosV 合併；**現 classic 最強**）、**反應流/Reactive**（`mirror`：鏡像對手上一動作＋對手放彈就 pounce）。
- **池外裁判**：**隨機擾動/Noise**（`noise`：加權隨機合法動作、只保留不自殺；強度地板/抗過擬合，不進 gate）。
- 舊 Aggressor/ChaosV/Tempering 已合併/移除（Aggressor→Hunter、ChaosV→Trapper）。各圖預設 champion ＝ Trapper（`ai/mapChampions.ts`）。

**決定性**：所有新增皆整數、BFS、固定順序、strict `>`；Noise/Reactive 只用 threaded bot RNG；無 `Math.random/Date.now/sqrt/sin/cos/performance`（`banned-tokens.test` 掃 `client/src/ai` 含 v3）。

> 不做逐 tick golden hash 鎖 AI：回歸保障由 `determinism.test`＋`v3-bench`（KILL-EDGE）＋`kill-probe` 機制診斷負責。
