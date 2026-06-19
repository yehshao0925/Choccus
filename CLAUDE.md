# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Cocoa Clash（Choccus）

巧克力主題的「炸彈超人」類即時對戰遊戲。放置炸彈 → 十字範圍爆炸 → 困住 / 救援。

> 下方「開發指令」與「程式架構」兩節是給 Claude Code 的工程速查；其後的一～四節是
> **遊戲設計文件**（主題決策、法律邊界、數值參數、AI 策略），改動玩法前先讀。

## 開發指令（Commands）

Monorepo：npm workspaces = `client` + `tools/sim-runner`；Python relay 在 `server/`（**獨立 venv**）。下列指令在 repo 根目錄執行。

| 目的 | 指令 |
| --- | --- |
| 安裝 JS 依賴 | `npm install` |
| 安裝 Python 依賴 | `python3 -m venv server/.venv && server/.venv/bin/pip install -r server/requirements.txt` |
| 前端 dev（Vite, `:5173`, hot-reload） | `npm run dev` |
| 前端 production build（先 `tsc --noEmit` 再 vite） | `npm run build` → `client/dist/` |
| Lint（ESLint，含 `sim/**` 決定性護欄） | `npm run lint` |
| Sim/AI 測試（`tsc --noEmit` + vitest） | `npm test` |
| Production serve（build + HTTP static `:8080` + WS relay `:8765`） | `npm run serve`（強制重 build：`npm run serve:rebuild`） |
| Dev WS relay（只跑 relay, `:8765`） | `server/.venv/bin/python server/main.py` |
| Python relay 測試 | `server/.venv/bin/python -m pytest server/tests -q` |

- **跑單一前端測試**：`cd tools/sim-runner && npx vitest run test/<檔名>.test.ts`（或 `npx vitest run -t "<test 名稱>"`）。
- **本機玩**：`npm run dev` 後開瀏覽器：`http://localhost:5173/`（預設＝線上大廳）、`?mode=solo`（單人 vs N bot）、`?mode=spectate`（看 bot 互打）、`?mode=net&room=test&autoready=1`（兩分頁自動同房開打，測連線用）。

### AI bench（在 `tools/sim-runner/`，**改完 AI 必跑**）

| 指令 | 用途 |
| --- | --- |
| `npm run matrix-bench` | 8-agent（v1×4 + v2×4）1v1 勝率矩陣，印每圖 rank-1 冠軍 |
| `npm run version-bench` | 活 bot vs 凍結前一版，4-bot FFA，兩圖，看 ΔWinRate / ΔAvgRank |
| `npm run replay -- fixtures/<f>.json [--jsonl]` | 跑 replay，逐 tick 印 `tick,hashHex` |
| `npm run gen-fixtures` / `npm run update-golden` | 重產 fixtures / 故意改 sim 後重 pin `fixtures/golden.json` |

## 程式架構（Code Architecture）

Monorepo：`client/`（TS + Vite + Pixi.js v8 前端）、`tools/sim-runner/`（headless 決定性測試 + AI bench，跑在 Node/tsx/vitest）、`server/`（Python WebSocket relay）、`shared/`（前後端共用 `constants.ts` / `types.ts` / `protocol.ts`）、`dypm.md`（AI 評分迴圈設計參考）。

**三層大圖：**

1. **決定性 sim 核心（`client/src/sim/`）** — 純整數邏輯，no Pixi / no net / no wall-clock。`Sim.ts` 的 `tick()` 有**固定系統順序**（見檔頭 1–9 步）＝決定性契約，**不可重排**。座標 int32 millitiles、PRNG Mulberry32（`Prng.ts`）、hash FNV-1a（`Hash.ts`）；同 seed + 同逐 tick 輸入 ⇒ 每 client byte-identical。ESLint 對 `sim/**` 強制：禁 import pixi/render/net，禁 `Date.now`/`Math.random`/`performance.now`/`Math.sin|cos|sqrt`（見 `eslint.config.js`）。**改 sim 機制務必同步更新 AI 的爆炸射線模型（見下）並重 pin golden。**
2. **時間 / 網路 / 渲染（`client/src/{net,render,input,ui,config}`）** — 所有 wall-clock timing 住這層。Solo 由 `main.ts` 跑 rAF + fixed-timestep accumulator 餵 sim；線上由 `net/LockstepEngine.ts` 跑 lockstep：本地輸入排到 `T + INPUT_DELAY_TICKS`、送 relay、relay echo 回**權威版本**，所有 slot 輸入到齊才推進一 tick，每 N tick 比對 `stateHash` 偵測 desync。`render/` 只在最近兩個 state 間內插。
3. **AI bot（`client/src/ai/`）** — 純函式 `(自帶 RNG, SimState) → InputFrame`，守與 sim 同一套決定性契約 → 可在 lockstep 房補位。共用感知層（danger map / BFS / 爆炸射線，**逐字對齊 `sim/Explosion.ts`**）在 `ai/common/`。

**入口與模式（`client/src/main.ts`）**：URL `?mode=` — 無＝線上大廳（`net/netMode.ts`）、`solo`、`spectate`（`spectate/spectateMode.ts`）。常用 param：`?bots= ?difficulty= ?strategy=`（archetype 或 `mix`）；net 用 `?room= ?autoready=1 ?ws= ?port=`。

**Server relay（`server/`）**：`main.py`＝dev relay（純 ws）、`serve.py`＝production（HTTP static + ws）。`relay/`：`RelayServer` / `TickCoordinator`（收齊輸入才放行該 tick；斷線 slot 補 neutral ghost）/ `Lobby` / `Room`。wire = 1-byte `MsgType` + MessagePack（id 定義在 `shared/protocol.ts`，Python 端手動鏡像）。relay **只中繼輸入、不跑 sim**。

**AI 版本制（`client/src/ai/`）**：每個 `ai/vN/` 是獨立、可並存的決策碼快照——**版本本身就是持久化機制，無另存 frozen baseline**（`baselines/` 已移除）。一律透過 `ai/index.ts` 的 version-agnostic factory 取用，呼叫端（`main.ts`、sim-runner）**絕不**直接 import 某 version 資料夾。每圖預設 bot ＝ matrix-bench rank-1 冠軍，定義在 `ai/mapChampions.ts`。完整版本狀態 / 強度 / 評估流程見 **`docs/ai-versions.md`**。

## 一、核心玩法

- 放置物（炸彈）+ 十字範圍爆炸 + 困住對手 + 隊友救援。
- 困住是**可逆**的（非致命），符合「被困 → 被救」的直覺，這是設計的核心約束之一。

## 二、主題決策：巧克力（已定案）

用**巧克力的相變（phase change）**當機制引擎，達成「一物兩用」：

- **融化** = 爆炸 / 攻擊。
- **凝固（糖殼 / 硬殼）** = 把對手困住的殼，可被破壞 → 困住完全自洽且可逆。

選巧克力的理由：四個約束全達標、**下限高、最難做爛**。

評估過的其他主題與淘汰原因：
- **奶油**：困住要靠額外「糖殼」才成立，不是一物兩用；白色易撞原作視覺。
- **岩漿**：相變等同巧克力，但「碰到=死」與「困住可逆」直覺衝突（較適合 floor-is-lava）。
- **科幻 / 奈米**：困住機制最強，但易撞預設藍、抽象需教學，下限低易翻車。

### 機制與美術解耦

- **機制歸巧克力**（材料 = 相變引擎：融=爆炸、凝固=困住殼）。
- **美術 / 世界觀歸蛋糕**（蛋糕 / 奶油 / 餅乾當場景，負責豐富度）。
- 唯一要注意：深褐色的**對比度**——用亮色背景即可解決。深褐色也讓視覺離原作的清涼藍最遠。

## 三、法律邊界（clean room）

**可以做**，但保護是分層的：

- **玩法 / 機制**（放置物、十字範圍、困住、救援）→ 不受著作權保護，自由使用。
  - 依據 *Tetris Holding v. Xio*：規則可拿，但「look and feel（具體視覺表達）」不能拿。
- **美術 / 音樂 / 角色 / 地圖 / UI** → 受保護，**必須全部自創**，不可模仿原作。
- **名稱 / 商標** → 不可用「爆爆王 / Crazy Arcade / BnB」(Nexon)；名字裡不可出現「Bomberman」(Konami)。
- **程式碼** → AI 從零生成原創邏輯沒問題；反編譯或抄原作 code 才侵權。

實作鐵則：
- 用 AI 時**只描述機制、不餵原作素材**（不連視覺一起複製），反而讓 clean room 更乾淨。
- 真正引爆風險的是**商業化與規模**，不是私下自製學習。

## 四、手感與數值參數

> 主題對應：炸彈 = 一坨**巧克力**，引爆 = **融化**（十字熔流），困住 = 對手被**糖殼凝固**包住。
> 下列數值是平衡值（mechanic/balance），可自由設定；命名維持巧克力主題。

### 手感參數（面板可調）

| 參數 | 預設 | 可調範圍 |
| --- | --- | --- |
| 移動速度 | 5.0 格/秒 | 3–8 |
| 轉角輔助容差 | 0.25 格 | 0–0.5 |
| 輸入緩衝 | 120 ms | 0–250 |

### 固定常數（寫死在程式裡）

| 項目 | 數值 |
| --- | --- |
| 邏輯更新頻率 | 60 Hz 固定 timestep（渲染另跑 rAF） |
| 地圖 | 15×13 格，格子 44px，外圈與偶數座標為硬磚 |
| 軟磚生成率 | 72%（出生角落保留 3 格淨空） |
| 引信時間 | **3.0 秒**（放下巧克力 → 融化引爆） |
| 火花持續 | 0.45 秒，十字熔流延伸、遇硬磚停、炸軟磚停、可連鎖 |
| 道具掉落率 | 軟磚 30%，火/速/炮 各 1/3 |
| 困住存活時間 | **5.0 秒**（被糖殼凝固後 5 秒內隊友碰到解救，否則破殼淘汰） |
| 重生保護 | 4.0 秒（重生模式才有；涵蓋出生瞬間） |
| 對齊滑行 | 速度與移動速度共用（轉角輔助沿垂直軸全速滑入） |

### 玩家初始值與上限

- 生命 **1 條**（被融流炸到 → 糖殼困住；**同隊**隊友碰=解救（救援優先）、**敵隊**玩家碰到困住者 → 立即破殼淘汰、無人碰且超時也會破殼淘汰。重生模式才會重生）
- 火力 2（上限 6）
- 炮數 1（上限 5）
- 速度加成 0（每顆 +0.4，上限 +2.0）

> 困住 / 救援採「糖殼凝固」模型，**沒有暈眩 / 無敵**那套；困住可逆正好對應主題的「凝固糖殼」。

### 對戰模式（PvP）

- 遊戲為純 PvP：**最後存活隊伍獲勝**（只剩 ≤1 個有存活玩家的隊伍 → 結束）。
- 隊伍預設 = slot（每人各自一隊）；以 `opts.teams` 指定才會分組成隊友。
- 不再有 PvE 敵人（原「燈籠妖」已移除——其隨機 AI 會自走入爆炸自殺）。solo 練習模式 = 玩家 + N 個 `BotController` AI bot 對戰（bot 有逃生／救援隊友／撿道具邏輯，且 prng-free、決定性，可用於連線房補位）。bot 架構與策略見下節。

### 移動模型（走道式格子移動）

- 角色座標以「格」為單位，整數即格心。
- 前方堵塞時最多走到本格中心。
- 垂直偏移在 `0.5 + 容差` 內且走道開放時，自動沿垂直軸滑入（轉角輔助）。
- 輸入採「後按優先」堆疊 + 緩衝重試。

### AI Bot（架構與策略）

決策採 **dypm 式單一加權評分迴圈**（非離散模式切換，勿改回「炸牆模式／對戰模式」兩段式）：每決策 tick 列舉 6 個固定順序候選（stay／4 向／放彈），算
`score = W_SURVIVE·survivability + W_RESCUE·rescue + W_ATTACK(aggression)·enemyPressure + W_ECON·econ + W_POSITION·position`，
取最高分。放彈前過**硬性安全閘門**（必須存在逃生路徑到視野內全程不致命的格，否則該動作淘汰）。所有策略共用同一核心，差別只在 `BotTuning` 旋鈕。

鐵則：完全決定性（禁 `Math.random`／`Date.now`／`Math.sqrt`，失誤注入用 threaded RNG，加總與 tie-break 順序固定）→ 可用於連線房補位；不加 Web Worker／round-robin。danger map 的爆炸射線須逐字對齊 sim 的 `Explosion.ts`（連鎖取最小引爆 tick、殘留 `[t, t+27)`、軟磚停格不殘留）。

策略 archetype 定義在各版本的 `client/src/ai/v<N>/Strategies.ts`（旋鈕在同版 `BotConfig.ts`）。難度三檔（easy／normal／hard）是另一組獨立的 `DIFFICULTY_PRESET`：

| 策略 | reaction | bombChance | maxEscape | aggression | 特色 | 強度（跨兩圖） |
| --- | --- | --- | --- | --- | --- | --- |
| **Aggressor（主動）** | 3 | 0.95 | 4 | 1.8 | 幾乎每個機會都放彈、反應銳利、逃生預算短：以安全餘裕換 tempo，持續施壓 | 綜合最強 |
| **亂V/ChaosV（亂V）** | 3 | 0.9 | 5 | 1.8 | 敵人 ≤4 格時放短 V／之字連環彈（`vChainBombs:3`，配速一顆一引爆絕不自爆，每顆都過完整逃生驗證），封堵逃生道困住逃竄者 | 第二（最穩定） |
| **Turtle（龜縮）** | 3 | 0.15 | 6 | 0.3 | 極少放彈、要求最長逃生路：靠拖垮對手而非擊殺 | 封閉圖強／開放圖弱 |
| **Gambler（賭徒）** | 12 | 0.9 | 4 | 1.3 | 反應遲鈍、常失誤、25% 機率盲放無逃生路（`recklessBombChance:0.25`）：高變異 boom-or-bust | 開放圖強／封閉圖弱 |

> 強度依 5 支自打 tournament（classic + pirate 各 240 場）。原 **Hunter**（平衡 all-rounder，兩圖皆偏弱）已移除（重構前的舊 AI 已棄用、不保留）。

#### AI 版本制（權威說明見 `docs/ai-versions.md`）

每個 `client/src/ai/v<N>/` 是獨立、可並存的決策碼快照——**版本本身就是持久化機制**，要演進就複製成下一版（`v3/`…）原地演進，不在舊版改、也**不另存 frozen baseline**（先前的 `tools/sim-runner/baselines/` 已移除）。各版的 `AI_VERSION` 在自己的 `v<N>/version.ts`；統一從 `ai/index.ts` 的 version-agnostic factory 取用。

- **v1**（凍結 baseline，`client/src/ai/v1/`）＝貪婪 1-ply 單層加權評分（不前瞻）。
- **v2**（最新 / live，`AI_VERSION = 2`，`client/src/ai/v2/`）＝在 v1 評分上加 **depth-4 forward-search maximin**（3 個悲觀場景）。引擎在 `v2/core/`（`forwardSearch` / `scenarios` / `commitment`，**map-agnostic**），每張地圖的策略旋鈕收斂成一個 `MapProfile`（`v2/{classic,pirate}/MapProfile.ts`，介面在 `v2/MapProfile.ts`），`BotController` 依 `SimState.mapKind` 派發。仍是**同一版**，classic/pirate 只是同版內依地圖派發的兩組 profile。
- **不做逐 tick golden hash 鎖 AI**：回歸保障由 `determinism.test.ts`（決定性）＋ `version-bench`（強弱變化）＋ `matrix-bench`（每圖冠軍）負責。改完活的 AI 後在 `tools/sim-runner/` 跑 `npm run version-bench`（活 bot vs 凍結前一版）與 `npm run matrix-bench`（v1×4 + v2×4 的 1v1 勝率矩陣 → 每圖 rank-1）。
