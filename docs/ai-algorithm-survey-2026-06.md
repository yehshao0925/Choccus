# Bomberman/Pommerman 對戰 AI 演算法調查 — 突破 v5 天花板的候選

> 2026-06-22。Deep-research（5 angle 並行 + 跨來源驗證）。目的：在「dypm 式悲觀情境前向搜尋已做滿」
> 的前提下，找出**還沒試過、且在整數決定性約束下可用**的演算法槓桿。
>
> **方法論誠實聲明**：本次 WebFetch 全程被環境擋（HTTP 403），所有數字來自 WebSearch 摘要的
> 跨查詢/跨 agent 交叉佐證，**非直接讀原文 PDF**。文中標 *(未驗)* 的精確數字需日後 fetch 解封後覆核；
> 命名定理與競賽名次屬高信心（多來源一致）。

---

## 0. 一句話結論（先講殘酷的）

**沒有「換個核心演算法就突破」的銀彈。** 這個遊戲家族唯一正式競賽（NeurIPS 2018/2019 Pommerman）的
結論是：**搜尋流完勝學習流**，而冠軍 dypm 用的正是「real-time tree search with pessimistic scenarios」
——**和你 v2 core 的 depth-4 悲觀情境 maximin 是同一招，而且你搜得更深**（dypm 約 depth 1、eisenach 約
depth 2，你 depth 4）。所以「靠更強的搜尋演算法輾過去」這條路，文獻說你已經在 SOTA、甚至更前面。

真正還沒動過、且有理論撐腰的槓桿有三條，**全部不是「更會搜」而是「搜以外的軸」**：

1. **線上對手建模 + 單調策略切換**（monotone policy switching）— 用你**現成的** forward-sim + archetype 池，
   理論保證「最壞不比單一最佳 archetype 差」。這是最像「新演算法」又能直接上決定性 bot 的一條。
2. **把評估從 Bradley-Terry 換成 α-Rank / Nash-averaging** — 你的 roster 是**刻意非遞移（RPS）**，BT 是
   單一純量模型、結構上無法表示環，會壓縮環內差距；且 Nash-averaging **對 clone 不敏感**——正好解掉
   「v4:zoner / v5:zoner 是近複製品擠在池子裡會不會扭曲排名」這個你問過的 v6 評估問題。
3. **離線 PSRO / Double-Oracle + exploiter 訓練**當「產生最不可被剋策略」的工具（離線、不上線推論）。

外加一條**機制澄清**：pirate「對稱詰死＝必須改 sim」的結論**過強**——那只在 optimal-vs-optimal 的
Nash 不動點成立；你的 v5-vs-v4 pirate ~50% 其實是**因為 pirate 的 v5 ≈ v4（robustRefuge 關）＝近自我對局**，
不是地圖的物理天花板。

---

## 1. 候選排名（payoff ÷ effort，標決定性可用性）

| 槓桿 | 能直接上決定性 bot？ | 突破力 | 工程量 | 風險 | 評級 |
| --- | --- | --- | --- | --- | --- |
| **A. 線上對手建模 + 單調策略切換** | ✅ 是（用現成 forward-sim + 池） | 中高（新軸） | 中 | 低（有 no-worse 保證） | ⭐ 首選（bot 層） |
| **B. α-Rank / Nash-averaging 取代/並列 BT** | ✅ 是（評估層、非 bot） | 中（修「看得準不准」） | **低** | 低 | ⭐ 首選（評估層） |
| **C. df-pn / MCTS-Solver 形式化「強迫擊殺」證明器** | ✅ 是（原生整數） | 中（擊殺轉化） | 中 | 低 | ◎ 推薦（已有雛形 `tryForcedTrap`） |
| **D. 離線 PSRO + exploiter → 產生最不可剋策略** | ⚠️ 僅離線（產物再蒸餾成規則才上線） | 中高 | 高 | 中 | ○ 值得做但重 |
| **E. 離線 self-play RL 當「啟發式發現器」→ 蒸餾成決定性規則** | ⚠️ 僅離線（NNUE 式整數 eval 或 decision-tree 才上線） | 不明（可能蒸餾掉強度） | 高 | 中高 | △ 探索性 |
| **F. 搜尋引擎升級（ID+TT+move-ordering / 整數 ProbCut）** | ✅ 是 | 低（你已比冠軍深） | 低–中 | 低–中 | ▽ 邊際 |
| **G. pirate 鏡像 komi / tempo tie-break** | 改 sim（產品決策） | 只解鏡像、不解強度 | 低 | — | 視需求 |

---

## 2. 五條證據線（精簡 + 出處）

### 2.1 競賽史：搜尋流完勝學習流（你已是這條的 SOTA）

- NeurIPS 2018 Pommerman **Team 賽**最終前五：1 hakozakijunctions、2 eisenach、3 **dypm**（皆 tree-search）、
  4 navocado、5 skynet（皆 RL）。控制重跑下「search based agents completely dominated」。
  *來源*：GAIGResearch wiki（唯一沒被 403 的頁）、`arxiv 1902.10870`、survey `arxiv 2203.09608`。**高信心**。
- **dypm = real-time tree search with pessimistic scenarios**：淺層（Pommerman 內約 depth 1）+ 每個 leaf 用
  **單一決定性悲觀情境**（假設超強對手）評估、悲觀程度用 self-play 調。eisenach（C++）平均搜深約 2。
  *來源*：`arxiv 1902.10870`（Osogami & Takahashi, ACML 2019）。機制**高信心**；「depth 1/2」精確值 *(未驗)*。
- **Skynet（RL，第 5）= PPO + "ActionFilter"**（剔除「必死」動作）+ reward shaping + curriculum。
  RL 唯有**接上等同你 `硬性安全閘門` 的安全濾網**才打得動。*來源*：`arxiv 1905.01360`。**高信心**。
- **為何 RL 在此難**：炸彈效果延遲 ~10 步（信用分配）、獎勵稀疏且**欺騙性**（贏常因對手自殺）、隨機
  探索高機率走進自己的爆炸。*來源*：`arxiv 1907.11788`（Gao et al., AIIDE 2019）。**高信心**。
- 2024 最強 self-play+population PPO 也**只追平 dypm**（"Elo almost equals dypm"），未明確超越。
  *來源*：`arxiv 2407.00662`。**高信心**（「追平」是作者原話；是否＝「超越」有詮釋空間）。
- **無任何 AlphaZero/MuZero/neural-MCTS 打敗過 Pommerman 搜尋冠軍**。唯一 AlphaZero 式系統（M2CTS, 2025）
  只把 Pommerman 當小規模泛化 demo，無強度宣稱。*來源*：`arxiv 2401.16852`。**高信心**（缺席證據）。

> **對 Choccus 的意義**：你的「悲觀 maximin + 硬安全閘門 + 整數決定性」就是奪冠配方，且**搜得比冠軍深**。
> 結論：**搜尋軸的剩餘空間很小**，突破靠別的軸。

### 2.2 對手建模 / best-response / 非遞移池（最有料的一線）

- **單調策略切換（monotone policy switching）**＝最可直接移植的理論：你已有決定性 forward-sim + 固定
  archetype 池。定理：**天真地「每步切到 per-state minimax 的 archetype」最壞可任意差**；但**單調切換**
  （只在可證明嚴格更優時才切）**最壞不差於池中單一最佳固定策略**。*來源*：King, Fern, Hostetler,
  "On Adversarial Policy Switching with Experiments in RTS Games", ICAPS 2013。**高信心**（headline 貢獻）。
- **modeling 只在對手可被剝削時才贏過 robust maximin**：零和對局無法同時「偏離去剝削」又「對任意對手
  保底遊戲值」；可安全剝削僅當對手給「gift」（走出均衡 support 的錯）。*來源*：Ganzfried & Sandholm,
  "Safe Opponent Exploitation", EC 2012；`arxiv 2201.04266`（Safe Equilibrium）。**高信心（概念）**。
- **純 best-response 很脆**：模型稍錯就崩；**Restricted Nash Response (RNR)** 用一個參數 p 在「Nash 安全 ↔
  best-response 剝削」之間滑，是 Pareto 最優的折衷。*來源*：Johanson/Zinkevich/Bowling, NIPS 2007;
  Johanson & Bowling, AISTATS 2009（Data-Biased Response）。**高信心**。
- **非遞移池的正解＝對族群取 Nash 混合（PSRO / Double Oracle）**，不是手挑剋星：DO 可證收斂到 minimax；
  PSRO＝DO + RL best-response oracle。AlphaStar 用 main/main-exploiter/league-exploiter + Prioritized FSP
  防止繞圈（StarCraft payoff 有 ~3,000,000 個 RPS 環 *(未驗)*）。*來源*：Lanctot et al. NeurIPS 2017;
  Balduzzi et al. ICML 2019; Vinyals et al. Nature 2019。**高信心（結構）**。
- **評估：BT 假設遞移，對刻意 RPS roster 會誤排**；**α-Rank**（演化/Markov-Conley-chain、多項式時間、處理
  環與不對稱）與 **Nash-averaging**（**對冗餘/clone agent 不變、自動降權**）是 cycle-aware 替代。
  *來源*：Omidshafiei et al., "α-Rank", Nature 2019 (`arxiv 1903.01373`)；Balduzzi et al., "Re-evaluating
  Evaluation", NeurIPS 2018（Nash-averaging）。**高信心（α-Rank）／中信心（Nash-averaging 那篇本次未直接命中）**。

> **對 Choccus 的意義**：①線上適應要做就做**單調切換**（有保證、用現成零件）；②**修評估**：你 docs §七
> 已知「BT 壓縮 RPS 環、靠印殘差補」——α-Rank/Nash-averaging 是這個 hack 的正規版，且 Nash-averaging 的
> **clone 不變性**直接回答你「v6 池放 v4+v5 近複製品會不會扭曲」。

### 2.3 搜尋引擎升級（決定性可用，但對你邊際）

- **最低風險、最高把握的非 exotic 升級＝iterative deepening + transposition table + killer/history move
  ordering**：等預算下搜更深或更省（有效分支因子趨近 √b），**全整數、零 RNG、lockstep 安全**。
  *來源*：chessprogramming.org；Schaeffer/Plaat。**高信心**。
  ⚠️ 但你的核心是「悲觀情境 maximin（不對對手分支、用固定悲觀尾）」，classical α-β 剪枝**只部分適用**；
  TT/move-ordering/ID 仍可用在**你自己的動作樹**。考量你已比冠軍搜得深 → **邊際**。
- **MCTS 系在戰術淺陷阱域弱於 minimax**（選擇性取樣會漏關鍵步）；要強就得把 minimax/solver 機制嫁接回去
  （implicit-minimax backups *(10–20% 未驗)*、eval-MCTS、MCTS-Solver 65% LOA *(未驗)*）——嫁接到最後**等於
  在 MCTS 裡重建決定性 α-β**。標準 UCT 本身**非決定性**（隨機 rollout + float UCB sqrt/log）→ lockstep 不安全。
  SHOT（Sequential Halving，無 UCB 常數、決定性配額）+ 整數 leaf eval 是「最像 MCTS 又決定性」的選項。
  *來源*：Baier–Winands (JAIR)；Cazenave (SHOT)。**方向高信心／數字未驗**。

### 2.4 強迫擊殺證明器：df-pn / PNS（你已有雛形）

- **Proof-Number Search** 在 AND-OR 樹上證明「forced win/not-win」，proof/disproof 都是**整數計數**、選點
  決定性（most-proving node）——**原生 lockstep 友善**。形狀正好是「我能否在 ≤N 步強迫擊殺/困住」
  （OR=我、AND=對手回應）。**df-pn**（低記憶體變體）解過 tsume-shogi 強迫將死。
  *來源*：Wikipedia/chessprogramming PNS；Müller et al. ICGA 2012。**高信心**。
- **MCTS-Solver** 把「已證敗」往上回傳、在 sudden-death 戰術線打得更準（LOA 勝 plain MCTS 65% *(未驗)*）。
- ⚠️ PNS 在**近均勻分支、無終局子目標**時退化成低效 BFS → **別當頂層控制器**，當**有界戰術子目標證明器**：
  每決策 tick 對「最近敵人 K 步內有無強迫擊殺」跑小額度 df-pn，證出就收割、否則回退悲觀 maximin。

> **對 Choccus 的意義**：你 `tryForcedTrap`（minimax forced-trap）/`tryFinishingMove` **已是手刻的證明式搜尋**；
> 文獻等於認證這個方向，並給出**把它換成有界 df-pn/MCTS-Solver** 的正規升級路徑，專打你點名過的「擊殺轉化」瓶頸。

### 2.5 追逃理論：解釋接觸稀缺、修正「對稱＝必改 sim」

- **同速單一追捕者在「有障礙的格子」上無強迫擒捕策略**：cops-and-robbers——2-D 格子 cop number＝2、
  環 C_n(n≥4) 一隻 cop 抓不到；連續版（Bhadauria/Klein/Isler/Suri, IJRR 2012）：多邊形帶障礙環境需
  **3 個同速追捕者**（充分、有時必要，與地圖複雜度無關）。微分賽局（Two Cars / Homicidal Chauffeur）：
  擒捕需 **v_追 > v_逃**，否則存在「draw（永遠逃脫）」區。*來源*：上述 + Cockayne/Isaacs。**高信心**。
  → 你的 **~7% 接觸率是理論常態，不是 bot 爛**。強迫接觸需：速度優勢／多追捕者／**縮圈**。
- **縮圈是教科書解**：PE 理論（Klein & Suri）證明單調縮小逃者安全可達集 → 任意小擒捕半徑下終必擒獲；
  battle-royale 設計論述（+ 一件 USPTO 專利）明言縮圈目的＝「強制交戰、防苟」。*來源*：socg13 Klein&Suri；
  gamedesignskills；USPTO 11964206。**高信心**。→ 你的 `sim/SuddenDeath.ts` 是**正規解、非 hack**。
- **「對稱＝50/50、只能改 sim」過強**：對稱零和賽局值＝0、最佳對最佳≈50/50——**但這只在 optimal-vs-optimal
  成立**。真 bot 是次優、有可被剝削的 archetype 弱點 → 更強的一方**合法** >50%（這正是你 classic v5-vs-v4
  55.6% 的來源）。*來源*：Brandl `arxiv 1611.06845`；Ganzfried `arxiv 2307.12338`。**高信心**。
  → **pirate v5-vs-v4 ~50% 是因為 pirate 的 v5≈v4（近自我對局）**，不是地圖物理上限。你「pirate 靠贏池、
  不靠贏鏡像」的實務立場**被理論證實**；要讓**鏡像本身**變可分勝負才需注入不對稱（komi / 決定性 tempo
  tie-break；**別用擲硬幣換邊**——那是把你想消的運氣加回去）。

### 2.6 學習成分若真要上線：必須整數決定性

- **整數推論可 bit-exact**：Jacob et al.（`arxiv 1712.05877`）weights/acts 8-bit、int32 累加，唯一的 scale 用
  **整數 multiply+shift（M0·2^−n）** 取代 float。**NNUE**（Stockfish 的整數 eval，int16/int8、clipped-ReLU）
  是「α-β 搜尋內跑整數神經 eval」的活證明。*來源*：上述 + stockfish NNUE docs。**高信心（NNUE 存在）**。
- **float 為何炸 lockstep**：float 加法非結合、跨 CPU/編譯器/opt 不同（x87 vs SSE、FMA、fast-math 重排）→
  必須 fixed-point。你 `sim/**` 已 ESLint 禁 `sqrt/sin/cos`＝同一紀律；任何 NN/UCB 須守同規。**高信心**。
- **蒸餾成 decision-tree/規則**（DAgger）＝最 trivially 決定性整數（一串整數門檻比較），但**有損**（分布偏移、
  會在 net 不會錯的地方犯錯）。Guo et al.：神經網路**模仿 MCTS 專家會掉強度**（即使 ~800k 步 *(未驗)*）。
  *來源*：`arxiv 2108.06898`；JAIR/IEEE-ToG 引述。**中信心**。
- **最務實用法＝search-as-teacher**：用離線 MCTS/RL 當**訓練期老師**或**啟發式發現器**，找出手調漏掉的權重/
  規則，再**手刻成決定性規則**上線——而非讓 net 取代搜尋。*來源*：Kartal et al. AAAI-AIIDE 2019 (PI-A3C)。**高信心**。

---

## 3. 對 Choccus 的具體下一步（v6 建議）

**先做（低風險、高槓桿）**
- **B｜評估升級**：把 `bt-rank` 的單一 Elo 補上 **α-Rank 排序**或 **Nash-averaging**（cycle-aware + clone 不變）。
  立即好處：(i) v6 對 RPS roster 的排名不再被環壓縮失真；(ii) **直接回答你問過的 v4/v5 近複製品入池問題**
  ——Nash-averaging 會自動降權近 clone，不必手動決定「v4 當不當判準」。低工程量，先把「看得準」立起來。
- **C｜把 `tryForcedTrap` 升級成有界 df-pn/MCTS-Solver 證明器**：原生整數、專打擊殺轉化；當子目標證明器、
  不當頂層控制器（PNS 近均勻分支會退化）。

**再做（中風險、新軸）**
- **A｜線上對手建模 + 單調策略切換**：用現成 forward-sim 對「對手像哪個 archetype」做決定性辨識，只在
  **可證明嚴格更優**時切到對應 best-response archetype（單調切換＝最壞不差於現役單一主幹）。這是文獻裡
  **最像「新演算法」又能直接上決定性 lockstep bot** 的一條，且 RNR/safe-equilibrium 告訴你別切到「純硬剋」
  而要切到「正則化的剋」以免自身變脆。

**離線工具（重、產物要再蒸餾才上線）**
- **D｜PSRO / Double-Oracle + exploiter**：以你的 roster 為種子族群、AI-bench 為 best-response oracle，產生
  **對該池最不可被剝削的 Nash 混合**；再把生還的 exploiter 折回池，當 v6 的硬化器。
- **E｜離線 self-play RL 當啟發式發現器**：只當老師/發現器，找漏掉的手調規則，**手刻成決定性版**上線
  （別讓 float net 直接上 lockstep）。預期：蒸餾會掉一些強度，故定位為「探索 + 撿靈感」。

**產品決策（非 bot）**
- **G｜pirate 鏡像**：若要讓**鏡像本身**可分勝負（而非靠贏池），唯一乾淨解是注入不對稱——komi 式補償或
  決定性 tempo/位置 tie-break。這改 gameplay、需你拍板；**不改也不影響 v6 靠贏池維持領先**。

---

## 4. 信心與爭議標記

- **高信心（多來源一致）**：2018 Team 名次與「搜尋完勝 RL」；dypm＝悲觀情境搜尋；Skynet＝PPO+ActionFilter；
  RL 難因（延遲/欺騙獎勵/自殺探索）；monotone switching 保證；RNR/safe-exploitation 概念；DO/PSRO 收斂；
  α-Rank；cop-number（grid=2、planar≤3、需 3 同速追捕者）；對稱值=0 只在最佳對最佳；縮圈＝PE 標準解；
  NNUE 整數 eval 存在；float 非結合炸 lockstep。
- **中／未驗（單一摘要、WebFetch 403 未覆核）**：implicit-minimax「10–20%」、MCTS-Solver「65% LOA」、
  ProbCut「74% Othello」、heuristic-MCTS「75% Reversi」、dypm「depth 1」精確值、2018 RL 只贏 0.4%/22 場、
  StarCraft「3,000,000 環」、蒸餾「800k 步掉強度」、2024「Elo almost equals dypm」的統計顯著性、
  Nash-averaging 原文（本次未直接命中）。**這些數字日後 fetch 解封再覆核；不影響上面的方向性結論。**
- **與 repo 既有結論的關係**：本調查**證實**（不是推翻）你的搜尋+安全閘門+縮圈是對的；**修正**的只有
  「pirate 必須改 sim」這句話的強度（那是鏡像/近自我對局現象，非地圖上限）。

### 最強追覽來源（fetch 解封後優先讀）
1. Osogami & Takahashi, *Real-time tree search with pessimistic scenarios*（你的核心同款）：`arxiv 1902.10870`
2. King/Fern/Hostetler, *Adversarial Policy Switching*（ICAPS 2013，單調切換保證）：oregonstate `icaps13-switching.pdf`
3. Omidshafiei et al., *α-Rank*（Nature 2019）：`arxiv 1903.01373` ＋ Balduzzi, *Open-ended Learning*（ICML 2019）：`arxiv 1901.08106`
4. Gao et al., *On Hard Exploration … Pommerman*（RL 難因）：`arxiv 1907.11788`；Skynet：`arxiv 1905.01360`
5. Jacob et al., *Integer-Arithmetic-Only Inference*：`arxiv 1712.05877` ＋ Stockfish NNUE docs（整數 eval 活證明）

---

## 5. v6 原型實測結果（2026-06-22，三條都試了）

| # | 原型 | 狀態 | 結果 |
| --- | --- | --- | --- |
| **①** | **α-Rank / Nash-averaging 評估**（`meta-rank`） | ✅ **出貨**（committed `1d9fe27`） | 兩圖跑出：**v5:zoner 是 dominant strategy**（α-Rank sink / Nash 100% support）＝**無 top-level 環，BT 的 #1 可信**；RPS 環在 mid-pool（farmer/zoner/trapper 三法三序）。Clone check 實證回答 v6 入池問題：**Nash 給被支配的近 clone v4:zoner ~0%、不扭曲全池** → v4+v5 同時入池在 Nash-averaging 下無害（mean-WR/Elo 會被拉偏），gate 對 Nash-support 冠軍 v5:zoner。 |
| **②** | **df-pn / MCTS-Solver 強迫擊殺證明器** | ⏸ **未建**（證據預判否決） | v5 已有 `tryFinishingMove` ＋ depth-2 `tryForcedTrap`（B1→B2）。repo **§六自己的 ablation**：「minimax forced-trap 加下去 25%→不變；瓶頸是接觸機會」＝擊殺轉化已飽和。再砸 df-pn surgery 被自家數據預判為 null → 不值得，除非先解接觸稀缺。 |
| **③** | **線上對手建模 + 單調切換**（`adaptDefense`） | ❌ **試了兩版→還原**（`fc6e439` 最終 revert，v5 逐位元未動） | flag-gated 原型：線上估「sealer aggression」→ 持續高就單調開防守旋鈕。**兩次 pirate A/B（CRN repeats=40），baseline = committed v5（trapper 59.4 / farmer 58.8 / v4 50.6）**：<br>• **retry#1（robustRefuge+corridorGate 都開）**：trapper **55.0**、farmer 57.5、v4 **50.0**。<br>• **retry#2（只開 corridorGate；robustRefuge 是 §十 記載的 pirate-負向槓桿，隔離掉）**：trapper **56.3**、farmer 57.5、v4 50.0。<br>**關鍵診斷**：adaptive corridorGate（56.3）**同時輸給 static-off(59.4) 與 static-on(62.5)** → 問題**不是哪顆旋鈕，是 on/off 切換動態本身**（gate 在交戰中閃爍、不一致地否決自己的彈，比任一穩態都差）。這正是「monotone-in-caution 不夠、要 monotone-in-VALUE」的實證（King/Fern/Hostetler）。**正解＝forward-sim value-dominance gate（較大建置），cheap trigger 此路不通。** |

> **總結**：三條只有 ①（評估層）是淨正、已出貨；② 被 repo 自家 ablation 預判飽和、未建；③ 是有理論依據但 naive 實作淨負、已還原（要做對得上 forward-sim value gate）。v5 主幹**逐位元未動**（②未碰、③已 revert）。**最大可行突破仍是評估升級（①）＋（若投資）③ 的 value-gated 完整版**。

---

## 6. 第二輪 web 驗證 ＋ fusion-panel 三方裁決 ＋ 實測（2026-06-22 下午）

> 起因：原調查（§0–§5）的 WebFetch 全程 403、數字僅 WebSearch 摘要佐證。本輪**重做 web 驗證**
> （這次 WebFetch 對 HTML 可用、僅 PDF 仍只能取 binary），加跑 `fusion-panel`（Gemini／Llama／gpt-oss
> ＋一席獨立聯網的 Claude sub-agent），並對唯一未測的便宜槓桿做了 `v5-screen` 實測。

### 6.1 web 驗證：原調查方向性結論**全部成立**（這次有讀到原文/摘要）
- **搜尋流完勝 RL**：dypm/hakozakijunctions = real-time tree search with pessimistic scenarios 拿下
  NeurIPS 2018 第 1/3 名，前三皆 tree-search。✅（PMLR v101/osogami19a、arxiv 1902.10870）
- **2024 最強 RL 只追平**：population self-play + curriculum 達 Elo **~982**，作者原話「**almost equals
  dypm**」，**未超越**；無 AlphaZero/MuZero 打敗過 Pommerman 搜尋冠軍；2025–2026 無新突破。✅（arxiv 2407.00662）
- **monotone policy switching**：「minimax policy switching 最壞可任意差；monotone 版 provably no worse
  than the minimax fixed policy in the set」。✅（King/Fern/Hostetler ICAPS 2013，原文措辭命中）
- 🆕 **原調查漏掉的一篇關鍵 paper**：**Wang et al., "Know your Enemy: MCTS with Opponent Models in
  Pommerman", ALA 2023（arxiv 2305.13206）**——把對手模型放進搜尋（two-player transform）：模型**準**時
  TP-MCTS 勝率 **0.78→0.91**；但「if one would use an optimal player as the opponent model, our agent
  would plan how to act in the worst-case scenario, irrespective of the actual behavior」，模型**錯/不匹配**
  時反而傷，self-play 對手模型會退化成「overly passive waiting」。**第二條獨立證據線**佐證 §2.2 的
  ③（opponent-model-in-search 有效但條件嚴苛、要帶安全下界）。

### 6.2 fusion-panel 三方裁決（盲點獵捕）
四席對「比 v5 更強的槓桿」獨立作答。**最有料的是獨立聯網的 Claude 席**（與共錨的 Llama/gpt-oss 去相關）：
- **A1（panel #1 理論重框）**：dypm 的真正教訓不是「悲觀」而是「**悲觀程度是可調超參、靠 self-play 調**」；
  純 maximin 對「不打最壞尾」的對手（farmer/runner/人類）**系統性低估自己進攻收益** → 提議混合尾
  `value=(1−β)·maximin+β·heuristic`。
- **C（pirate 對稱牆）**：引 MAPF corridor-symmetry 文獻——對稱邏輯不可能從內部產生非對稱結果，須注入
  **外部決定性種子**（slot-id tie-break）。
- **B**：hard value-dominance gate 不值得大建置，改做 **α-restricted-Nash 軟混合**（連續 α、自帶最壞情況
  下界、消除 adaptDefense 的閃爍）；模型**只用對手物理量**（位置/火力/逃生分支），**禁用 archetype 分類器**
  （分類器只認識 eval roster、對人類必崩）；驗收加 **roster 外對照（noise 不得變差）** 防過擬合。
- **D2**：把防守 `entrapWeight` 反用為**進攻** entrapment（獎勵壓住已被逼進死胡同的敵人），攻「接觸機會」瓶頸。

### 6.3 對 code 覆核 → 兩條 panel 主張被**現實打折**（必須查 code、不能只信 LLM）
- **A1 其實大半已做**：`v5/core/forwardSearch.ts` 頭註明寫「survivability 取 3 scenario 的 **MIN（maximin）**；
  **reward 只對 scenario[0]＝樂觀 baseline 算一次**」。即**進攻 reward 本來就用樂觀尾、不悲觀**；悲觀只是
  純安全地板。故「β 混合尾解開被低估的進攻」這個 panel #1 前提**不成立**（reward 已樂觀）。
- **C（slot-id）有雙 seating 平均陷阱**：bench 是雙 seating CRN，slot-id 是「綁 slot 不綁策略」→ 對稱鏡像下
  slot 0 系統性贏＝我方半數場是 slot 0 → net 回 ~50%。正是 doc 作者警告的「別用擲硬幣換邊」。**過不了對稱 gate。**

### 6.4 實測：唯一未測的便宜槓桿 **offEntrap（進攻 entrapment，panel D2）→ DROP**
加 per-map flag `offEntrap`（reuse `escapeBranches` 算**敵人**格的逃生分支，敵在交戰距內且自身在死胡同時，
按接近度**獎勵**逼近收割）。default 0＝逐位元 v5。`v5-screen`（paired CRN、early-stop、vs ship-gate v4:zoner
＋mirror v3:trapper）：

| 地圖 | vs v4:zoner（ship-gate） | vs v3:trapper | 判定 |
| --- | --- | --- | --- |
| pirate | **−1.0%**（z−0.6） | +3.1%（z+1.4） | INCONCLUSIVE |
| classic | **−6.3%**（z−0.8） | +5.2%（z+0.7） | INCONCLUSIVE |

> **抬 trapper、掉 v4 鏡像**——與 §八/§十記載的**每一條進攻槓桿完全相同的「被鏡像讓掉」失敗簽名**。
> 即「進攻 entrapment」也只是又一條 attack lever。**已 revert，v5 逐位元未動。**

### 6.5 本輪淨結論
1. **沒有可移植的「更強演算法」**（web 三向確認，含一篇新 paper）。v5 的悲觀搜尋＋安全閘＋縮圈就是 SOTA 配方。
2. **panel 的新點子對 code 覆核後**：A1 大半已實作；slot-id 有對稱平均陷阱；D2 實測 = 又一條被鏡像讓掉的
   attack lever（DROP）。→ **bot 層的便宜對症空間已枯竭**（classic 由 corridorGate 收尾、pirate 是對稱牆）。
3. **唯一仍有理論依據、尚未做對的 bot 層槓桿**：§2.2 ③ 的**正版**＝把對手模型（**只用物理量、不用 archetype
   分類器**）放進 forward-sim，做 **α-restricted-Nash 軟混合**（非 hard gate、自帶最壞情況下界、驗收帶 roster
   外 noise 對照）。這是**較大建置 + 過擬合風險**，須走完整三階段管線，非 quick verify 範圍。
4. **pirate 對稱牆**：bot 層確認近枯竭（slot-id 不可靠），要破只能**改 sim**（非對稱縮圈／komi／決定性 tempo
   tie-break）＝產品決策。

> 追覽來源（本輪）：arxiv 2305.13206（opponent-model-in-search，**新**）、2407.00662、1902.10870、
> ICAPS 2013 policy-switching、safe-equilibrium 2201.04266、MAPF symmetry-breaking（SoCS/ICAPS）。
