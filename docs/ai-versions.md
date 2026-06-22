# AI 版本狀態（Choccus Bot）

> 最後更新：2026-06-22（**死亡軌跡/空間診斷 → classic 對症修法成功：走廊感知放彈閘門**。詳見 §十。
> 重點：①新工具 **`v5-trace`**（空間死亡回放，看 seal 怎麼合圍）。②**classic 死因＝trapper 的「單寬走廊
> vChain 封殺＋自堵」**（`v5-diag` TRAPPED 28/33）→ 對症修法 **`corridorGate`**（敵近時放彈須有逃生分支
> ≥2 的交叉口逃生點，否則否決）→ **classic Elo 1783→1827（#1 +61→+106）、vs v4 55.6%→68.8%、
> vs trapper 58.8%→70%、全池零退步、pirate byte 不變**。③**pirate 死因＝收圈最後一格的「對稱擠壓」**
> （縮圈牆包死、非對手；foe bombs=0）＝結構性 50% 對稱牆，bot 走位翻不了 → pirate 已在策略族最佳點，
> 八個 pirate 槓桿（進攻重掃/openRefuge/tempo-bomb/shrink-aware survivability 等）全 A/B 否決還原。）
> 最後更新前一版：2026-06-21（**v5 上線＝v4 Zoner 主幹 ＋ 全新正交「防守軸：逃生路線冗餘」**。詳見 §九。
> 重點：①v4 的天花板（v3:trapper 封鎖鏡像）與玩家實測死法是同一件事——**躲死胡同／站位不安全→被補一顆封殺彈打死**；先前「只有進攻槓桿、全被 trapper 讓掉」的結論只試過進攻面，**防守面（逃生冗餘）正交未試**。②v5 兩機制：**反封殺位置罰分 `entrapWeight`**（罰逃生分支<2 的死胡同格、按敵接近度加權）＋**穩健逃生點 `robustRefuge`**（放彈後逃向分支最多的格；classic 開、pirate 關）。③結果：**BT 量尺兩圖 #1（v4 退第二，classic +61 / pirate +18，皆 ≥1 SD）**、直接對 v4 兩圖 ≥ 勝（classic 55.6%、pirate 50%）、對 v3:trapper ~54%→**61–63%**（天花板突破）。④新工具 **`v5-diag`**（失敗軌跡診斷：死亡分類＋死前 10 秒軌跡）。
> 最後更新前一版：2026-06-21（**v4 上線並兩圖各自調參完成 + 遊戲重平衡 caps**。詳見 §八。
> 重點：①遊戲 caps 提高（火力上限 6→**7**、彈數上限 5→**6**），golden 全綠、**兩圖 BT 量尺已用新 caps 重 seed**；②v4 主幹＝**控場流/Zoner**，評估改以 **Bradley-Terry 量尺**為準；③新增三個機制（**長射程發育 fire-7**、**sudden-death 縮圈生存走位 shrinkSurvival**、**角落封殺 cornerFinish**）；④結果 **classic #1 +42、pirate #1 +48**（皆對第二名）；⑤天花板＝**trapper 是 v4 同流派的「封鎖鏡像」**，所有「更兇/更發育/更早交戰」槓桿都會把 trapper 讓掉，故領先卡在這。⑥工具：`bt-rank`/`bt-seed` 新增 `--map` 過濾，單圖評估快 ~5×。⑦新增 **`v5-probe`** 新策略快速 A/B 探針（vs 前沿封鎖者 `v4:zoner`＋`v3:trapper` 直接 CRN、不寫 history、印 SHIP-GATE）；移除 4 個 v2 期過時 throwaway 評估腳本（`probe-classic`/`probe-map`/`sweep-classic`/`v3-sweep`，詳見 §七末）。）
> 最後更新前一版：2026-06-20（**新增 sudden-death 縮圈機制**（`sim/SuddenDeath.ts`）——120 秒起由外往內螺旋收硬磚、踩到即淘汰，~179 秒收滿全場，徹底消滅 farm-to-timeout。超時率兩圖 89%→**0%**，限時擊殺率 classic 10.8%→**69.2%** / pirate 2.5%→**81.7%**，KILL-EDGE 兩圖仍 PASS。）
> 評估工具：`tools/sim-runner/` — **v4 起以 `bt-rank`（Bradley-Terry 量尺、含 `--map` 單圖過濾）為權威**；歷史：`v3-bench`（KILL-EDGE）、`kill-probe`、`v2-rank`、`v3-diag`/`v3-trace`、`matrix-bench`、`version-bench`。

## v3 目標（`/goal`）：對 v2 限時獵殺 — ✅ **KILL-EDGE** 達成；sudden-death 後限時擊殺率衝上 69–82%

> **2026-06-20 規則：超時（拖到 3 分鐘 tick cap，雙方都活）＝挑戰者(v3)判輸**（唯同 tick 互炸 0.5 平手）。v3 必須在時限內**真的擊殺** v2 才算贏。

**舊結論「純擊殺 80% 是物理天花板」已被 sudden-death 推翻——那個天花板的前提是「永遠有地方等速逃逸」，縮圈機制把這前提拿掉了。** 先前窮舉（kill doctrine → 7-archetype roster → 登月 pincer/finisher → minimax forced-trap）證明的是：在**固定大小**的圖上、靠**搜尋／策略**無法突破接觸機會的上限（兩等速 bot 平均相距 ~8 格、僅 ~7% 時間在獵殺範圍；pirate 開放圖是 pursuit-evasion 殘局，~0-3%）。結論依然成立，但它指向的解法——**「需要強迫接觸的遊戲設計槓桿（sudden-death 縮圈）」——現在做出來了**（`sim/SuddenDeath.ts`），於是擊殺率不再受那條天花板限制。

gate 仍是物理公平的 **KILL-EDGE**（v3 最強 archetype 在**每張圖**對最強 v2 的限時擊殺數 ≥ v2 擊殺 v3 數、且總和嚴格較多）；只是 sudden-death 後 v3 連絕對擊殺率也一併拉高了。

sudden-death 後實測（`v3-bench --workers=8 --repeats=30`，每格 60 場、CRN、**超時＝v3 判輸**）：

| 地圖 | 最佳 v3 | 限時擊殺率 | v3 擊殺 / v2 擊殺 | KILL-EDGE |
| --- | --- | --- | --- | --- |
| **classic**（封閉） | v3-farmer | **69.2%** | 41 / 18 | ✅ EDGE v3 |
| **pirate**（開放） | v3-zoner | **81.7%** | 49 / 11 | ✅ EDGE v3 |

> 超時率兩圖皆 **0%**（先前 ~89%）。歷史脈絡：sudden-death 前 baseline classic 10.8% / pirate 2.5%，幾乎全超時；登月 forced-kill 曾把 classic 推到 25%。最強 v3 archetype 由 hunter/trapper 換成 **farmer/zoner**——收圈場上過度進攻（hunter/reactive）反而自滅（pirate 僅 1.7–3.3%），發育＋控場才贏。「各圖最強 v2」仍由 `v2-rank` 判定＝aggressor。

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
| **v3** | 凍結（BT 量尺 roster） | v2 引擎 + **連通性教條**（孤立時農到完成、連通後交戰）＋修掉 v2 農田凍結（道具 Manhattan 磁鐵 bug）＋多彈叢集農田＋保住領先撤退 | `client/src/ai/v3/`（`core/` + `classic/` + `pirate/`） |
| **v4** | 凍結（`AI_VERSION = 4`） | 由 v3 收斂成**單一主幹**＝**控場流/Zoner**，兩圖各自一套 `MapProfile`：classic 疊 fire-7 + shrinkSurvival + cornerFinish + ring2 + huntStart1200（**#1, +42**）；pirate 疊 fire-7 + shrinkSurvival(6)（**#1, +48**）。配合遊戲 caps 提高（fire 7 / cannon 6） | `client/src/ai/v4/`（`core/` + `classic/` + `pirate/`） |
| **v5** | **最新 / live**（`AI_VERSION = 5`） | v4 Zoner 主幹 ＋ 全新正交**防守軸：逃生路線冗餘**——反封殺位置罰分 `entrapWeight`（罰逃生分支<2 的死胡同格）＋ 穩健逃生點 `robustRefuge`（放彈後逃向分支最多的格；classic 開、pirate 關）。**BT 兩圖 #1（v4 退第二）**、直接對 v4 兩圖 ≥ 勝 | `client/src/ai/v5/`（`core/` + `classic/` + `pirate/`） |

- 兩版各自是獨立、可並存的決策碼快照；版本本身就是持久化機制（無另存的 frozen baseline）。
- **v2 地圖分軌（2026-06-19）**：v2 的決策引擎抽進 `client/src/ai/v2/core/`（`forwardSearch` / `scenarios` / `commitment`，map-agnostic），每張地圖的策略旋鈕收斂成一個 `MapProfile`（`client/src/ai/v2/{classic,pirate}/MapProfile.ts`，介面在 `v2/MapProfile.ts`）。`BotController` 依 `SimState.mapKind`（新增的非 hash 比賽常數）在第一次 `sample()` 選定 profile 並快取。**仍是同一個 `AI_VERSION = 2`、同一份註冊表**——classic/pirate 只是同版內依地圖派發的兩組策略，不是兩個版本。目前兩 profile 數值相同（== committed v2，純結構重構，行為與 matrix-bench 逐字未變）；之後各圖各自調 profile 即可，不互相影響。
- 共用感知層在 `client/src/ai/common/`（危險圖 `dangerMap`、BFS、爆炸射線等，逐字對齊 sim 的 `Explosion.ts`）。
- 兩版共用同一組 4 個策略 archetype：**Aggressor / Turtle / Gambler / ChaosV**（旋鈕在各自的 `BotConfig.ts` / `Strategies.ts`）。
- 決定性契約（各版皆守）：純函式 `(自帶 RNG, SimState) → InputFrame`；禁 `Math.random / Date.now / performance.now / Math.sqrt / sin / cos`；整數評分、固定候選順序、strict `>` 平手取第一。可用於連線房 lockstep 補位。
- **v4 啟動（2026-06-21）**：由 v3 原封複製、收斂成**單一主幹策略**（依 §七 的單一策略版本流程）。主幹＝**控場流/Zoner**——**評估鏡頭自此改以 Bradley-Terry 量尺為準**（停看 v3-bench KILL-EDGE gate / fair-duel），而 BT 下 zoner 是兩圖都最強的單一策略（pirate #1 1757–1762、classic 頂端叢集，皆壓 farmer）。v4 launch 行為與 v3:zoner 逐字相同，再就地演進；**先攻較弱的 classic 圖**（baseline `bt-rank --target=v4:zoner`，逐對手殘差顯示 v3 發育/控場族是 classic 的硬對位）。

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
# BT 量尺（v4／v5 開發）
npm run bt-rank -- --target=v4:zoner --map=classic       # 放上 v3 量尺 → Elo ladder ＋逐對手殘差
npm run v5-probe -- --target=v5:<arch>                   # 新策略快速 A/B：vs 前沿封鎖者（v4:zoner＋v3:trapper）直接 CRN，不寫 history
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

## 七、Bradley-Terry 版本量尺（v4／v5 開發用）

> 目的：把 **v3 roster 當固定量尺**，之後 v4／v5 各開發**單一策略**，只跟 v3 池 1v1 打「夠用」場次，靠 Bradley-Terry 從**稀疏** pairwise 結果反推出**全體**在同一 Elo 尺度上的評分——舊版對局結果保留為資料、永不重跑，新版只補打跟池子的對局即可。

**模型**：每個 agent 有潛在強度 β，`P(i 贏 j) = σ(β_i − β_j)`。用 MM（minorisation–maximisation）迭代從 win/games tally 解 MLE（梯度自由、單調收斂、純整數外只用 `exp/log/abs`，決定性）。平手算 0.5；弱「對 phantom 平局」prior 讓全勝／全敗 agent 不發散。β 只有差值有意義 → **錨定 v3 池均值 = Elo 1500**，使「1500 = 平均 v3」跨重擬合穩定、v4／v5 直接可比（即使彼此沒對打，透過共同 v3 對手聯合估計）。

**勝負編碼（sudden-death 後）**：贏 = 在時限內擊殺對手（炸死**或**縮圈壓死），同 tick 互炸 = 0.5 平手。farming 拖超時已機制性不可能，故**無**「超時＝判輸」特例。

**非遞移診斷**：v3 是刻意 RPS 環，BT（單一尺度）會壓縮環內差距——這是特性不是 bug。`bt-rank` 另印**逐對手「觀測 vs BT 預測」殘差**，殘差大負＝該策略被某 v3 archetype 剋（單一 Elo 看不到的非遞移訊號）。

**目前量尺**（2026-06-21 **以新 caps（fire 7 / cannon 6）重 seed**，`bt-seed --map=<m> --repeats=100`，每對 200 場 × 兩 seating、CRN，錨定池均值＝1500）：

| 名次 | classic | Elo | | pirate | Elo |
| --- | --- | --- | --- | --- | --- |
| 1 | v3:zoner | 1675 | | v3:zoner | 1758 |
| 2 | v3:farmer | 1669 | | v3:farmer | 1744 |
| 3 | v3:trapper | 1661 | | v3:trapper | 1738 |
| 4 | v3:runner | 1478 | | v3:runner | 1620 |
| 5 | v3:hunter | 1321 | | v3:hunter | 1264 |
| 6 | v3:reactive | 1197 | | v3:reactive | 876 |

> 新 caps 下結構不變：發育／控場（zoner/farmer/trapper）擠在頂端 ~1660–1758，過度進攻的 hunter/reactive 墊底（reactive 開放 pirate 尤其弱）。量尺存於 `bt-history/{classic,pirate}.json`（committed）。**caps 改動會讓整池行為改變 → 必須重 seed**（這次兩圖都重跑過）。

**v4:zoner 就位（新 caps、`bt-rank --map=<m> --repeats=100`）**：

| 地圖 | v4:zoner Elo | 名次 | 領先 #2 | 逐對手勝率（zoner/farmer/trapper/runner/hunter/reactive） |
| --- | --- | --- | --- | --- |
| **classic** | **1720** | **#1** | **+42**（v3:zoner 1678） | 56 / 53 / 54 / 86 / 93 / 97 |
| **pirate** | **1789** | **#1** | **+48**（v3:zoner 1741） | 62 / 55 / 59 / 74 / 95 / 97 |

> 兩圖都壓過整池 → #1。**綁住領先的是 v3:trapper（54–59%）**：它跟 v4:zoner 同為「封鎖型」，是策略鏡像，互相抵消（v4 反而電爆正面進攻的 hunter 93–95%）。逐對手殘差證實：farming-intensity（cannon surplus、econ boost）、提早交戰（huntStart↓）、收環、加重 seal 等槓桿**全部把 trapper 讓掉**；唯一有效的是**長射程 fire** 與**縮圈終局走位**，兩者皆已拉滿。

**程式**（`tools/sim-runner/`）：
- `bradley-terry.ts`：純 BT 引擎（MM 擬合、錨定、log-likelihood、勝率預測、連通性 union-find 護欄）。
- `bt-history.ts`：per-map 持久化對戰歷史（`bt-history/{classic,pirate}.json`），canonical `v<N>:<arch>` 配對 key、**upsert-by-pair**（重跑取代不重複計數）。
- `bt-seed.ts`（`npm run bt-seed`）：跑 v3 內部 round-robin，寫出全新量尺。**v3 變動時重跑**。
- `bt-rank.ts`（`npm run bt-rank -- --target=v4:<arch>`）：跑 target vs v3 池 → upsert → 對整份歷史聯合重擬合 → 印全域 ladder（target 就位）＋逐對手殘差。`--no-write` 乾跑。
- `v5-probe.ts`（`npm run v5-probe -- --target=v5:<arch>`）：**新策略快速 A/B 探針**——跑 target vs **前沿封鎖者**（預設 `v4:zoner`＋`v3:trapper`，`--opponents` 可指定任意 `v<N>:<arch>` 混版本對手）直接 CRN 對打，印逐對手勝率、對 live 冠軍（最高版本對手）的 **SHIP-GATE 判定**，外加可 diff 的 SUMMARY 行。**不擬 BT、不寫 history**，是純開發迴圈工具：改前/改後各跑一次比勝率位移。預設 `--repeats=40`，`--map` 過濾。

```bash
cd tools/sim-runner
npm run bt-seed -- --repeats=60 --workers=8           # 一次性建量尺（v3 變動才重跑）
npm run bt-rank -- --target=v4:hunter --repeats=60    # 把 v4 單一策略放上量尺
npm run v5-probe -- --target=v5:disruptor --map=classic  # 開發 v5 時的秒級 A/B（vs 前沿封鎖者）
```

> 連通性護欄：BT 只在連通分量內共用尺度。target 打完整 v3 池即自動連通；若只打子集且斷開，`bt-rank` 會報出哪些 agent 孤立、要求補對局。
> 預設池＝6 個 gate archetype（同 `v3-bench`）；`--include-noise` 可把 noise 當底部錨點加入。

**為什麼 v5 開發要用 `v5-probe` 而非只看 `bt-rank` Elo**：`bt-rank` 把 target 對 v3 池打完後，它對 **v4:zoner** 的關係是透過共同 v3 對手**遞移推斷**的；而 v3 roster 是刻意非遞移（RPS），對一個**全新家族**，這個遞移邊正是最不可信的數字——v5 可能對 v3 池 Elo 很高卻**直接輸給現役 v4**。故 v5 的**真正出貨判準 = 對 `v4:zoner` 兩圖直接 CRN 勝率 ≥ 50%**（`v5-probe` 的 SHIP-GATE），BT Elo 只當「落在 ladder 哪一格」的次要讀數。早期 design 還不知 binding 對手是誰時，預設同時打 `v4:zoner`（live 冠軍）＋`v3:trapper`（最強封鎖鏡像、v4 的歷史天花板），看哪個 binding 再收窄。**v5 落版時建議把 `v4:zoner` 也 `bt-seed` 進池**，讓 v6 對著真正前沿（而非只有 v3）量。

**已移除的過時評估工具**（2026-06-21，皆 v2 期一次性 throwaway、未 wire／未被 import／文件無引用）：`probe-classic.ts`（診斷 v2 在 classic 凍結——§四已解決）、`probe-map.ts`（傾印出生角 tile，一次性 debug）、`sweep-classic.ts`（v2 classic MapProfile 注入掃描，標記 DO NOT SHIP）、`v3-sweep.ts`（v3 旋鈕掃描——v3 已凍結為量尺，掃其旋鈕無意義）。
> **`--map=<classic|pirate>`（2026-06-21 新增）**：只跑/只寫該圖（另一張圖的 history 不動）。調單圖時（另一張 profile 中性）省掉另一張的對局，classic-only 快 ~5×（pirate 對局較慢）。CRN 與全跑逐位元一致（seed 用全域 map index）。`buildChallengerGames`/`buildGameList` 都吃這個 maps 過濾。

## 八、v4（最新 / live，`AI_VERSION = 4`）— 兩圖各自調參 + 遊戲重平衡

v4 由 v3 收斂成**單一主幹策略 Zoner**，評估改以 **Bradley-Terry 量尺**為準（不再看 v3-bench KILL-EDGE / fair-duel）。launch 時行為與 v3:zoner 逐字相同，再就地演進。**兩圖各一套 `MapProfile`（`v4/{classic,pirate}/MapProfile.ts`）**，互不影響（這就是「兩個地圖兩套策略」——同一 archetype、依 `SimState.mapKind` 派發兩組旋鈕）。

### 遊戲重平衡（caps，2026-06-21）
- `shared/constants.ts`：`PLAYER_MAX_FIRE` 6→**7**、`PLAYER_MAX_CANNON` 5→**6**（起始值 fire 2 / cannon 1、速度 base 5→max 7 不變）。當作我方平衡值（clean-room：程式裡不放原作角色名）。
- 影響：golden determinism 測試**全綠、不需重 pin**（既有 fixtures 場景未觸及新上限格）；但 v3 BT 量尺在舊 caps 失效 → **兩圖都用新 caps 重 seed**（§七），v4 再重新就位。

### 三個有效機制（per-map 旋鈕，介面在 `v4/MapProfile.ts`）
1. **長射程發育 `devTargetFire`**（classic 7 / pirate 7；中性 4）＝**最大單一槓桿**。把發育目標推到新上限 7 → 十字熔流更長 → seal/封鎖蓋更多出口、追得到逃竄者。classic 實測一舉把三個硬對位同時拉高（trapper 48→55、farmer 50→57、鏡像 58）。少量道具就到，不會過度農。
2. **sudden-death 縮圈生存走位 `shrinkSurvivalWeight`**（classic 4 / pirate 6；中性 0）＝**破鏡像的主槓桿**。縮圈將至時預先朝「會晚一點才硬化的中心」靠，比只會對已硬化格反應的近似鏡像多活一手。pirate 把鏡像 50→**62%**（權重 6 為峰值；7/8 會開始讓掉 trapper）。
3. **角落封殺 `cornerFinish`**（classic on / pirate off）：最近敵人被逼到死角（自由空間 ≤3）時，把 Zoner 環收到 1、撲上去用多彈 pincer 封殺，而非在環上繞圈讓它溜走。封閉 classic 有效；開放 pirate 角落少、實測中性故關閉。

### 其他 per-map 旋鈕
- classic：`huntStartTick` 1200（kill 時鐘提早；600 太早會被 trapper 反殺 45%、2400 太晚過農——1200 是甜蜜點）、`zoneStandoffTiles` 2（收環施壓；3 鬆掉 seal、pirate 收環則讓掉 trapper 故維持原型寬環 0）。
- `devTargetCannon` 維持中性 3：提到 4/5（多彈做大封鎖）**實測淨負**——多發育＝多農＝被侵略的 trapper 懲罰（bot 仍會撿 cannon 道具，不靠提高農田目標也有彈做封鎖）。`devEconBoostMax`、`sealWeightMult` 提高同理皆淨負（trapper 讓分）。

### 天花板（已窮舉，兩圖一致）
**v3:trapper 是 v4:zoner 的封鎖鏡像**（同為走位封鎖型，互相抵消），是綁住領先的對位（54–59%）。所有「更兇/更緊/更發育/更早交戰」槓桿都用 trapper 換別人、淨值 ≤0；只有**殺傷力（fire 射程）**與**終局走位（縮圈）**正交有效、且已拉滿。要再往上需要 trapper 結構上沒有的**全新 sim 機制**（例如「捕捉後短暫加速」），那會改動所有玩家的 gameplay、偏離既有 trap/rescue 設計，需另行授權，非調參可達。**結論：classic +42、pirate +48（皆 #1）即現行可達峰值。**

### 改完 v4 的回歸檢查
`npm run lint`（含 `sim/**` 決定性護欄）＋ `npm test`（決定性／禁用 token／行為護欄）＋ `bt-rank --target=v4:zoner --map=<m>`（BT 就位，調哪張圖跑哪張）。caps 若再動 → 重 `bt-seed` 兩圖 + 視情況 `update-golden`。

## 九、v5（最新 / live，`AI_VERSION = 5`）— 防守軸：逃生路線冗餘（突破 v4 天花板）

v5 由 v4 原封複製（v4 凍結），主幹策略仍是 **控場流/Zoner**、archetype 旋鈕逐字不變。
v5 **不在進攻面動刀**，而是開一條 v4 天花板分析從未試過的**正交防守軸**。

### 為什麼是防守軸（v4「天花板」的再框定）
§八 的結論是「trapper 是封鎖鏡像，所有進攻槓桿都把 trapper 讓掉 → 卡住」。但那組窮舉
**只試了進攻面**（更兇 / 更發育 / 更早交戰 / 加重 seal）。關鍵洞見：**v3:trapper 的殺法
＝vChain 連鎖封路彈把對手逃生道一一封死**，這跟使用者實測 v4 的死法是**同一件事**——
「v4 有時自己躲進死胡同、或站位不安全，被補一顆就死」。也就是說 v4 的天花板對位與玩家
觀察到的死亡是**同一個機制：被後續封殺彈關進無第二出口的格**。對策不是更會打，而是
**永遠保留逃生冗餘**——這條軸正交於所有進攻槓桿，trapper 結構上無法用「讓別人」抵消。

### 失敗軌跡診斷（`v5-diag`，「死因十秒前就有跡象」）
新增 `tools/sim-runner/src/v5-diag.ts`：逐 tick 追 target 的**逃生分支數**（死胡同偵測）、
對敵 BFS 距離、安全自由空間、發育差，死亡時分類（SEALED 死胡同／OPEN 時機／TRAPPED 糖殼）
並快照**死亡當下 / 1 秒前 / 10 秒前**的軌跡。實測（entrap 版）關鍵發現：
- **vs v3:trapper（classic）**：v5 已勝 ~65%，殘餘敗局 **11/12 是 TRAPPED**，死亡當下
  `enemyBombsNear≈2.8`＝多彈 vChain 封殺，逃生分支在最後數秒由 2.5 崩到 1.1。
- **vs v4 鏡像**：敗局集中在 **sudden-death 縮圈期**且**發育差為負**；死前 10 秒逃生分支
  （1.86）就已低於勝局（2.18）——印證「縮圈前已被逼到窄區」的早期跡象。

### 兩個機制（per-map 旋鈕，介面在 `v5/MapProfile.ts`）
1. **反封殺位置罰分 `entrapWeight`**（兩圖 10）：敵在交戰距內時，每個 leaf 依
   `entrapWeight × max(0, 2 − escapeBranches(結果格)) × 接近度` 扣分。`escapeBranches`
   ＝從結果格往外、**禁止回到自身格**、有界 flood，數有幾條獨立分支能抵達真安全格
   （死胡同/單出口 ≤1）。只重排「該站哪個安全格」，**不碰硬逃生閘門與 survivability flood**，
   故絕不會把 bot 推進更不安全的格。**踩過的雷**：曾加「只有敵有空炮才罰」的閘門，反而在
   trapper vChain 進行中（它的炮都拿去放封殺彈了 activeBombs≈cannon）關掉防守 → trapper
   由 61.7% 跌到 55.8%，已還原；威脅是「即將成形的封殺」，用**接近度**觸發才對。
2. **穩健逃生點 `robustRefuge`**（classic 開、pirate 關）：放彈後的**承諾逃生點**不再取最近的
   有效格，而是在 `maxEscapeLen` 內掃所有有效格、取**逃生分支最多**者（同分取最近）。便宜的
   布林放彈閘門仍走最近格快路徑（與 v4 逐位元相同）、只有每次真放彈付一次成本。
   **per-map 的理由（不可調和的取捨）**：封閉 classic 上這是純贏（逃去交叉口而非死胡同，
   擋掉補刀）；開放 pirate 上「追遠處高分支逃生點」會掉農田 tempo、輸給 v3 發育流
   （pirate BT 1809→1766），而把它 tempo-bound 又會讓鏡像優勢崩掉（45%）——開放圖的鏡像
   優勢與農田 tempo **耦合**，故 pirate 關掉、純靠 entrap 項拿下量尺。

### 結果（權威：`bt-rank --repeats=60`，committed 量尺 `bt-history/`）
| 地圖 | v5:zoner Elo | 名次 | #2 | 領先 | v5 逐對手勝率（hunter/farmer/zoner/runner/trapper/reactive） |
| --- | --- | --- | --- | --- | --- |
| **classic** | **1783** | **#1** | v4:zoner 1722 | **+61**（約 4 SD） | 97 / 63 / 62 / 90 / 63 / 98 |
| **pirate** | **1805** | **#1** | v4:zoner 1787 | **+18**（約 1.4 SD） | 94 / 57 / 64 / 77 / 61 / 98 |

直接對打（`v5-probe --repeats=40`，CRN、draws=0.5）：**classic 對 v4:zoner 55.6%、pirate 50.0%**；
對 v3:trapper **classic 58.8%、pirate 57.5%**（v4 約 54–59%，trapper 對位明顯改善）。
**結論：v5 兩圖 BT #1、v4 退第二（classic +61、pirate +18，皆 ≥1 個標準差）；trapper 天花板被防守軸正交突破。**

### 天花板再框定後仍在的對位
v5 對 **v3:trapper 仍是 RPS 環上相對偏弱的方向**（trapper 是封鎖環的剋星），但防守軸把它
從 ~54% 拉到 **classic 63% / pirate 61%**（觀測已貼齊 BT 預測、殘差 ≈0），不再是綁住領先的
對位。**pirate 鏡像是真正的 50% 對稱牆**（cannon4、shrink-aware、late-robust 三種槓桿實測
皆無法撼動鏡像、或反而掉量尺），故 pirate 領先靠贏整池、不靠贏鏡像；防守軸也讓「更發育/
更兇」這類先前被 trapper 鎖死的進攻槓桿重新有額度可花（未來 v6 方向）。

### 改完 v5 的回歸檢查
`npm run lint`（含 `sim/**` 決定性護欄）＋ `npm test`（決定性／禁用 token／行為護欄，v5 全綠）＋
`bt-rank --target=v5:zoner --map=<m>`（BT 就位）＋ `v5-probe --target=v5:zoner`（直接對 v4 ship-gate）。
caps 若再動 → 重 `bt-seed` 兩圖。**v6 起建議把 `v4:zoner`／`v5:zoner` 都已在 committed 量尺中，
新版直接對前沿量。**

## 十、pirate 上限調查 ＋ 死亡軌跡/空間診斷（2026-06-22）

> 方法論：先用 **死亡軌跡診斷**（死因十秒前就有跡象）找出 v5 到底「怎麼輸」，再針對死因
> 設計修法、A/B 測。比「猜槓桿再測」嚴謹得多。新增**空間回放**工具看 seal 怎麼合圍。
> **結論：classic 天花板＝trapper 的「單寬走廊 vChain 封殺」，`v5-trace` 看到具體長相 → 對症修法
> 走廊感知放彈閘門 `corridorGate` ✅ 已實作出貨（classic Elo 1783→1827、trapper 58.8%→70%，見下節）。
> pirate 死因＝收圈最後一格的結構性對稱擠壓（縮圈牆、非對手），bot 走位翻不了 → 已在「Zoner+entrap」
> 策略族最佳點；八個 pirate 槓桿（含 corridorGate）全因過不了 v4 對稱鏡像 ship gate 而否決還原。**

### 新工具：`v5-trace`（空間死亡回放）
`tools/sim-runner/src/v5-trace.ts`（`npm run v5-trace -- --target=v5:zoner --opponent=v4:zoner
--map=<m> --nth=0`）。`v5-diag` 給的是**聚合數字**（分支數/敵彈數）；`v5-trace` 兩遍法（CRN
決定性）找出第 N 個敗局、重跑、印**死前 10s/3s/1s/死亡**的 ASCII 盤面（`@`我`F`敵`B`我彈
`X`敵彈`!`即將致命`#`硬磚`o`軟磚`·`開放），直接**看見** seal 怎麼合圍。

### pirate 死因＝收圈最後一格的「對稱擠壓」（非對手所為）
`v5-diag`（v5 vs v4 鏡像，pirate）：**35/35 敗局全在縮圈期、27 個 SEALED（死胡同）**，死時
敵人在 ~4.9 格外、身邊敵彈僅 ~0.5、發育打平；逃生分支 **2.34(死前10s)→1.23(1s)→0.37(死)**
——10 秒前還跟勝局一樣安全。`v5-trace` 證實：**全程 foe bombs = 0**，縮圈牆把全盤硬化成一小塊
pocket、bot 拿到較差的格→被牆包死。**對手沒有封你，是縮圈在封；對手只是贏了搶最後存活格的硬幣。**
兩個用相同邏輯的 bot 爭同一格→ ~50/50，**bot 走位無法把對稱變不對稱**（`shrinkSurvivalWeight`
已做 30s 早期中心漂、survivability 縮圈感知的 look-ahead 只有 3s＝看到牆時已被困）。

### classic 死因＝trapper 的「單寬走廊 vChain 封殺」＋自堵
`v5-diag`（classic）：**28/33 TRAPPED（糖殼）、主要中盤、死時身邊 ~2.3 顆敵彈**。`v5-trace`
看到具體死法：v4 把 bot 趕進**單寬垂直走廊**（東西皆硬磚），北端用 vChain 連下 2–3 顆敵彈封死，
而 **bot 自己**撤退放的彈把南端退路也堵住 → 自我密封。放彈時 `validateBombRefugePessimistic`
驗證的是「往北逃」，但 v4 **隨後補彈**把那條已驗證走廊逃生道切斷＝閘門的盲點。這就是 §八/§九
點名的 **trapper binding ceiling 的具體長相**。

### 被否決的 pirate 槓桿（皆 entrap 開著、CRN repeats=40，對 v4 ship-gate / trapper / farmer）
| 槓桿 | vs v4 | vs trapper | vs farmer | 判定 |
| --- | --- | --- | --- | --- |
| baseline（committed v5） | 50.6% | 59.4% | ~57% | — |
| 進攻：econ200 + cannon4 | 45.6% | 60.0% | — | 破鏡像 |
| 進攻：huntStart1200 + ring2 | 43.8% | 56.9% | — | 破鏡像 |
| 進攻：cornerFinish on | 48.8% | 59.4% | — | 中性、無助益 |
| 結構：aggression 1.4→1.0 | 48.8% | 58.1% | 55.0% | 中性、無明確勝 |
| 防守：openRefuge=40（無閘門） | 50.6% | **50.0%** | 53.1% | 破 trapper |
| 防守：openRefuge=40（foe-far 閘門） | 48.1% | 53.8% | 56.3% | 破 trapper+鏡像 |
| 你的點子：tempo-bomb（躲好就補彈） | **36.9%** | 54.4% | **40.6%** | 暴跌（自砍逃生分支） |
| 對症：shrink-aware survivability | **52.5%** | 53.8% | 60.0% | 名目過 gate，但… |

> **shrink-aware survivability**（把縮圈硬化時刻表 `HARDEN_TICK` 接進**敵人無關**的
> `survivability` flood——修正先前 commit 7c29d81 把它錯接到只在近敵觸發的 `escapeBranches`／
> entrap，碰不到 foe-far 的縮圈死亡而被還原）：名目第一次打贏 v4（52.5%），**但 `v5-diag` 確認
> 死亡型態完全沒變（仍 27 SEALED）**——分支死前 10s 才崩、3s look-ahead 來不及；且 `bt-rank`
> 全池淨退步（pirate pool Elo 1805→**1787**＝#2，trapper -5 蓋過 farmer +3）。classic 上同改動
> ~中性（v4 53.8%/55.6 base、trapper 58.1、farmer 66.3）——因 classic 死於 TRAPPED 非縮圈。
> **故還原。**

### 對症方向
- **pirate**：對稱擠壓只有**改 sim 縮圈機制**能破（例如讓最後存活格不對稱、或縮圈留下可爭奪的
  非對稱優勢）——改 gameplay，需產品決策。bot 層已窮盡。
- **classic ✅ 已實作出貨**：對症修法＝**走廊感知放彈閘門 `corridorGate`**——見下節。

### ✅ 對症修法成功：走廊感知放彈閘門（`corridorGate`，classic Elo 1783→**1827**）
`v5-trace` 證實 classic 死法＝trapper 把 bot 趕進單寬走廊、用 follow-up 彈封一端，bot **自己**撤退
放的彈封另一端＝自我密封。根因＝放彈閘門 `validateBombRefugePessimistic` 只把敵人壓力彈模擬在
**敵人當前格**、且**要求敵人有空炮**（vChain 進行中敵人炮都用掉了→被跳過），所以**沒預期到敵人
推進走廊口補彈封死已驗證的逃生道**。

**修法（`v5/MapProfile.ts` 旋鈕 `corridorGate`，classic 開、pirate 關）**：放彈時若有可攻擊敵人
在交戰距內（**Manhattan、炮數無關**——威脅是即將成形的封鎖、非當下空炮），驗證到的逃生點必須
**逃生分支 ≥ ENTRAP_BRANCH_TARGET(2)**（是交叉口、非單出口走廊）；否則該放彈被硬否決。`corridorGate`
關時逐位元＝v4 fast path。

**結果（CRN repeats=40）**：
| 指標 | committed v5 | corridorGate |
| --- | --- | --- |
| classic vs v4（probe） | 55.6% | **68.8%**（+13.2）|
| classic vs v3:trapper（probe） | 58.8% | **70.0%**（+11.2，天花板被打破）|
| classic vs v3:farmer（probe） | ~63% | **66.9%** |
| `v5-diag` TRAPPED 死亡 / W:L:D | 28 / 42:33:5 | **19 / 54:24:2**（67.5%）|
| **classic BT Elo（bt-rank）** | 1783（#1 +61） | **1827（#1 +106）** |

逐對手殘差全池無退步（trapper 70 / zoner 74 / farmer 67 / hunter 95 / runner 88 / reactive 99）。
三重確認一致（probe 全漲＋diag TRAPPED 暴跌＋bt-rank Elo +44）。`npm test`／`lint` 全綠。
**這是 v5 上線後第一個對症修法成功的 AI 改進。**

**pirate 為何維持 `corridorGate:false`**（同修法在 pirate 也測了）：corridorGate=true 在 pirate
**幫了非對稱對位**（trapper 59.4→62.5、farmer 升）**卻跌破 v4 鏡像 ship gate（50.6→47.5）**——對
不靠 seal 的 v4 Zoner，它只是 veto 掉 v5 自己有用的彈，而 pirate 真正死因（縮圈牆、非對手 seal）
它碰不到。v4 直接勝率是主要判準，故 pirate 關閉、classic-only 出貨；pirate 逐位元不變、零回歸。
