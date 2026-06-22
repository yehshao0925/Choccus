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
