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
| `npm run v3-bench -- --workers=8 --repeats=150` | **v3 權威評估**：v3 對 v2 的 1v1 勝率＋80% 門檻（平行化、CRN）。**超時＝挑戰者(v3)判輸**（拖到 3 分鐘 tick cap 未擊殺即算輸；唯同 tick 互炸算 0.5 平手）。`--map=classic --v2=aggressor` 為快速單圖調參迴圈 |
| `npm run v2-rank -- --map=classic` | v2 內部 1v1 排名，找該圖最強 v2（gate 目標；兩圖皆 aggressor） |
| `npm run v3-diag` / `npm run v3-trace` | v3 機制診斷（道具差/死亡/擊殺）、逐時農田軌跡 |
| `npm run matrix-bench` | 8-agent（v1×4 + v2×4）1v1 矩陣（v1 vs v2 歷史） |
| `npm run bt-seed -- --repeats=60` | 建 **Bradley-Terry 量尺**：v3 內部 round-robin 寫 `bt-history/{classic,pirate}.json`（v3 變動才重跑） |
| `npm run bt-rank -- --target=v4:<arch>` | 把新版單一策略放上 BT 量尺：vs v3 池 → 聯合重擬合 → 全域 Elo ladder ＋逐對手殘差（詳見 `docs/ai-versions.md` §七） |
| `npm run v5-probe -- --target=v5:<arch>` | **新策略快速 A/B 探針**（不寫 history、不擬 BT）：target vs **前沿封鎖者**（預設 `v4:zoner`＋`v3:trapper`，可 `--opponents=v<N>:<arch>,...` 混版本）直接 CRN 對打，印逐對手勝率＋對 live 冠軍的 SHIP-GATE 判定。改前/改後各跑一次比勝率位移；`--map` 過濾、`--repeats=40` 預設。理由＝新家族對 v4 的關係 BT 只能遞移推斷、最不可信，必須直接量（詳見 `docs/ai-versions.md` §七） |
| `npm run v5-diag -- --target=v5:zoner [--opponent=v3:trapper]` | **失敗軌跡診斷**：跑 target vs 對手，逐 tick 追 target 的逃生分支數 / 對手距離 / 自由空間 / 發育差；死亡時分類（SEALED 死胡同／OPEN 時機／TRAPPED 糖殼）並印死亡當下 / 1 秒前 / 10 秒前的軌跡——「輸掉的原因十秒前就有跡象」。純分析、不寫 history |
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

**AI 版本制（`client/src/ai/`）**：每個 `ai/vN/` 是獨立、可並存的決策碼快照——**版本本身就是持久化機制，無另存 frozen baseline**（`baselines/` 已移除）。一律透過 `ai/index.ts` 的 version-agnostic factory 取用，呼叫端（`main.ts`、sim-runner）**絕不**直接 import 某 version 資料夾。每圖預設 bot ＝該圖最強 archetype（`ai/mapChampions.ts`）；2026-06-21 起兩圖皆 **v5:zoner**（BT 量尺下兩圖都 #1、且兩圖直接對 v4:zoner 皆 ≥ 勝）。完整版本狀態 / 強度 / 評估流程見 **`docs/ai-versions.md`**。

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
| 對局時間上限 | **3.0 分鐘**（180 秒 = 10800 ticks；打滿仍多隊存活 → sim 強制結束，依「最多存活人數 → 道具發育數」判勝，全平手算平手） |
| Sudden death（突然死亡） | **120 秒（7200 ticks）起**，每 25 ticks 由外往內螺旋把一格內場變硬磚、踩在上面者**直接淘汰**（凝固包死、不可救）；~179 秒收滿全場 → 比賽不可能拖到上限還多隊存活。消滅 farm-to-timeout（`sim/SuddenDeath.ts`，純整數決定性、不抽亂數） |
| 對齊滑行 | 速度與移動速度共用（轉角輔助沿垂直軸全速滑入） |

### 玩家初始值與上限

- 生命 **1 條**（被融流炸到 → 糖殼困住；**同隊**隊友碰=解救（救援優先）、**敵隊**玩家碰到困住者 → 立即破殼淘汰、無人碰且超時也會破殼淘汰。重生模式才會重生）
- 火力 2（上限 **7**）
- 炮數 1（上限 **6**）
- 速度加成 0（每顆 +0.4，上限 +2.0）

> 2026-06-21 重平衡：火力/彈數上限由 6/5 提高到 **7/6**（高爆風建構，做更大封鎖範圍）。caps 在 `shared/constants.ts`；改動會改變整個 sim → 須重 seed v3 BT 量尺（兩圖已重跑），golden 不需重 pin。

> 困住 / 救援採「糖殼凝固」模型，**沒有暈眩 / 無敵**那套；困住可逆正好對應主題的「凝固糖殼」。

### 對戰模式（PvP）

- 遊戲為純 PvP：**最後存活隊伍獲勝**（只剩 ≤1 個有存活玩家的隊伍 → 結束）；另設 **3 分鐘對局上限**，打滿仍多隊存活則 sim 強制結束，依「**最多存活人數 → 道具發育數**」判勝、全平手算平手（判定在 `sim/Outcome.ts`）。
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

> 上表為 v1/v2 的 archetype。**v3（2026-06-20 限時獵殺重做）改成刻意非遞移的 7-archetype roster**：三環 **獵殺流/Hunter ＞ 養成流/Farmer ＞ 控場流/Zoner ＞ Hunter**＋邊緣專家 **逃跑流/Runner**（純存活）、**陷阱流/Trapper**（vChain 封路誘殺，由舊 ChaosV 合併，**現各圖最強**）、**反應流/Reactive**（鏡像反制）＋池外裁判 **隨機擾動/Noise**（強度地板，不進 gate）。舊 Aggressor→Hunter、ChaosV→Trapper，Tempering 移除。旋鈕＝`v3/BotConfig.ts` 的 `pureHunt/fleeFoe/zoneStandoff/mirror/noise`。
>
> **gate ＝物理公平的 KILL-EDGE**（v3 限時擊殺數 ≥ v2 擊殺 v3 數，每圖）。先前「純擊殺 80% 是物理天花板」的前提是「永遠有地方等速逃逸」；**2026-06-20 新增 sudden-death 縮圈機制（`sim/SuddenDeath.ts`）把這前提拿掉後，限時擊殺率衝到 classic 69.2% / pirate 81.7%、超時率兩圖 0%**，KILL-EDGE 仍 PASS。詳見 `docs/ai-versions.md`。

#### AI 版本制（權威說明見 `docs/ai-versions.md`）

每個 `client/src/ai/v<N>/` 是獨立、可並存的決策碼快照——**版本本身就是持久化機制**，要演進就複製成下一版（`v3/`…）原地演進，不在舊版改、也**不另存 frozen baseline**（先前的 `tools/sim-runner/baselines/` 已移除）。各版的 `AI_VERSION` 在自己的 `v<N>/version.ts`；統一從 `ai/index.ts` 的 version-agnostic factory 取用。

- **v1**（凍結 baseline，`client/src/ai/v1/`）＝貪婪 1-ply 單層加權評分（不前瞻）。
- **v2**（凍結，`AI_VERSION = 2`，`client/src/ai/v2/`）＝在 v1 評分上加 **depth-4 forward-search maximin**（3 個悲觀場景）。引擎在 `v2/core/`＋每圖 `MapProfile`，`BotController` 依 `SimState.mapKind` 派發。
- **v3**（凍結＝**BT 量尺 roster**，`AI_VERSION = 3`，`client/src/ai/v3/`）＝由 v2 演進：**連通性教條**＋修掉「道具 Manhattan 磁鐵」bug、道具優先 cannon/speed、近距才完整保命、多彈叢集農田、保住領先撤退。7-archetype 刻意非遞移 roster，現作為 v4/v5 的固定 Bradley-Terry 量尺（`bt-history/{classic,pirate}.json`）。詳見 `docs/ai-versions.md`。
- **v4**（凍結，`AI_VERSION = 4`，`client/src/ai/v4/`）＝由 v3 收斂成**單一主幹策略 Zoner**，評估改以 **Bradley-Terry 量尺**為準。兩圖各一套 `MapProfile`（同 archetype、依 `mapKind` 派發兩組旋鈕）。三個有效機制：**長射程發育 `devTargetFire`=7**、**sudden-death 縮圈生存走位 `shrinkSurvivalWeight`**、**角落封殺 `cornerFinish`**（classic on）。配合遊戲 caps 提高（fire 7 / cannon 6）。**結果 classic #1 +42、pirate #1 +48**。v4 當時的天花板＝v3:trapper 是同流派「封鎖鏡像」——但那是只試過「進攻槓桿」的結論；v5 用**防守槓桿**突破。詳見 `docs/ai-versions.md` §八。
- **v5**（**最新 / live**，`AI_VERSION = 5`，`client/src/ai/v5/`）＝v4 Zoner 主幹 ＋ 一條全新且正交的**防守軸：逃生路線冗餘**。v4 的天花板（v3:trapper）與玩家實測死法是同一件事——**躲進死胡同／站位不安全 → 被補一顆封殺彈打死**。v5 加兩個機制：①**反封殺位置罰分 `entrapWeight`**（敵在交戰距內時，罰逃生分支 <2 的死胡同格，按接近度加權）；②**穩健逃生點選擇 `robustRefuge`**（放彈後逃向分支最多的格、非最近的死胡同格；classic 開、pirate 關——開放圖追遠逃生點會掉農田 tempo）。結果：**BT 量尺兩圖 #1（v4 退第二）**，且直接對打 v4 兩圖 ≥ 勝（classic 55.6%）、對 v3:trapper 由 ~54% 升到 ~59%。診斷靠 `v5-diag`。詳見 `docs/ai-versions.md` §九。
- **不做逐 tick golden hash 鎖 AI**：回歸保障由 `determinism.test.ts`（決定性）＋ **`bt-rank`（BT 量尺就位）**＋機制診斷負責。改完活的 AI（v5）後在 `tools/sim-runner/` 跑 `npm run bt-rank -- --target=v5:zoner --map=<圖>`（調哪張圖跑哪張）＋ `npm test` ＋ `npm run lint`。caps 若再動須重 `bt-seed` 兩圖。
- **開發新策略（v5＋）的快速迴圈**：用 `npm run v5-probe`（前沿封鎖者直接 CRN A/B，秒級訊號），鎖定 binding 對手（live 冠軍 `v4:zoner`＋鏡像 `v3:trapper`）反覆 A/B；方向定了再 `bt-rank` 上量尺、`npm test`、`npm run lint`。**出貨判準＝對 `v4:zoner` 兩圖直接勝率 ≥ 50%**（光是 v3-池 Elo 高不算數，可能輸給現役 bot）。v5 落版時建議把 `v4:zoner` 也 `bt-seed` 進池，讓 v6 對著真正前沿量。
