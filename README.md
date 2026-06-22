# 奶油啵啵爆（Choccus）

> 🌐 **語言 / Language**：**中文（本頁）** ｜ [English](./README.en.md)

巧克力與蛋糕奶油主題的即時線上多人對戰遊戲：在格子地圖上放下蛋糕 →
引爆成十字範圍 → 黏呼呼的奶油把對手黏住困住 → 在時間耗盡前救援隊友。

> 本檔為快速上手指南（安裝、執行、部署、測試、架構）。AI 版本的狀態與
> 評估流程見 [`docs/ai-versions.md`](./docs/ai-versions.md)。

## 環境需求

| 工具 | 版本 |
|------|---------|
| Node.js | 18 以上（在 25 上測試過） |
| npm | 8 以上（在 11 上測試過） |
| Python | 3.11 以上 |

## 安裝

```sh
# 1. JavaScript 依賴（client + tools）
npm install

# 2. Python 依賴
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
```

---

## 開發模式（Vite + relay，熱重載）

開**兩個**終端機：

```sh
# 終端機 1 — WebSocket relay（預設埠 8765）
server/.venv/bin/python server/main.py

# 終端機 2 — Vite dev server（埠 5173）
npm run dev
```

開兩個瀏覽器分頁到 `http://localhost:5173/?mode=net` 即可對戰。

### 單人 / 觀戰（不需 relay）

前端也能完全離線跑，對手是決定性 AI bot：

| 網址 | 模式 |
|-----|------|
| `http://localhost:5173/` | 線上大廳（預設） |
| `http://localhost:5173/?mode=solo` | 一名玩家 vs N 個 AI bot（`&bots=`、`&difficulty=`、`&strategy=`） |
| `http://localhost:5173/?mode=spectate` | 看 AI bot 互相對打 |

### 零點擊自動就緒（自動化 / CI）

```
http://localhost:5173/?mode=net&room=test&autoready=1
```

用兩個分頁開上面這個網址，會自動加入同房並開始。

用 `&port=<n>` 連到不同埠的 relay：

```
http://localhost:5173/?mode=net&room=test&autoready=1&port=9000
```

---

## 正式 / 部署模式

### 1. 建置前端

```sh
npm run build
# → client/dist/  （可直接 serve 的靜態檔案）
```

### 2. 啟動正式伺服器

```sh
bash scripts/serve.sh
# 或透過 npm：
npm run serve
```

這會啟動兩個服務：

| 服務 | 預設埠 | 可設定方式 |
|---------|-------------|-----------------|
| HTTP（靜態前端） | **8080** | `CHOCCUS_STATIC_PORT` 環境變數或 `--static-port` |
| WebSocket relay | **8765** | `CHOCCUS_PORT` 環境變數或 `--port` |

在兩個瀏覽器分頁開 `http://<server-ip>:8080/`，點 **Quick Match**（或在兩個
分頁輸入同樣的房名），線上對戰就會開始。

### 容器（Docker / Podman）

`Dockerfile` 是多階段建置：Node 先建 `client/dist`，再由 Python runtime
跑 `serve.py`（靜態 `:8080` ＋ WS relay `:8765`，同一個行程）。

```sh
podman build -t choccus .          # 或：docker build -t choccus .
podman run -d -p 8080:8080 -p 8765:8765 choccus
```

推到 `main` 會經由 `.github/workflows/build-image.yml` 建置並發佈 image 到
GitHub Container Registry：

```sh
podman pull ghcr.io/pttcodingman/choccus:latest
```

（套件初始為 private — 用 PAT 拉取，或在 repo 的 **Packages** 設定裡設為 public。）

### 前端如何解析 WS URL

前端會自動解析 relay 的 URL — 不寫死 `localhost`：

| URL 參數 | 效果 |
|---|---|
| `?ws=wss://example.com:8765` | 明確指定完整 URL，覆蓋預設 |
| `?port=9000` | `ws[s]://<同一 hostname>:9000` |
| _(無)_ | `ws[s]://<同一 hostname>:8765`（預設） |

當頁面以 HTTPS 提供時，會自動使用 `wss://`。

### serve 前強制重新建置前端

```sh
bash scripts/serve.sh --rebuild
# 或：
npm run serve:rebuild
```

### 分離 host/port 設定（relay 在不同主機或在反向代理後）

明確傳入完整的 WS URL：

```
http://<static-host>:8080/?ws=wss://relay.example.com:8765
```

遊戲內產生的邀請連結會保留 `?ws=` 參數，朋友可直接點擊。

### 反向代理（nginx / caddy）

如果在前面放一個做 TLS termination 的反向代理，設定它：
- 在 `/` 以 HTTPS 提供 `client/dist/`
- 把 `/ws`（或另一個子網域／埠）的 WebSocket 連線代理到 `ws://localhost:8765`

接著用 `https://` 開站 — 前端會自動升級成 `wss://`。

---

## 執行測試

```sh
# 決定性 / 模擬 / AI 測試（vitest：tsc --noEmit + golden hash）
npm test

# Python relay 伺服器測試（pytest）
server/.venv/bin/python -m pytest server/tests -q
```

> AI bot 的基準測試與評估流程（`tools/sim-runner/` 下的各項 bench）屬於內部
> 開發迴圈，自架不需要。權威說明見 [`docs/ai-versions.md`](./docs/ai-versions.md)。

---

## 架構總覽

Monorepo：npm workspaces（`client` + `tools/sim-runner`）＋一個獨立的 Python relay。

```
shared/                  — 前後端共用：constants.ts、types.ts、
                           protocol.ts（1-byte MsgType + MessagePack wire 格式）

client/src/
  main.ts                — 入口；URL ?mode= 選 大廳（預設）/ solo / spectate
  sim/                   — 決定性、純整數的模擬核心
                           （no Pixi/net/wall-clock；ESLint 護欄 — 保持決定性）
  net/                   — lockstep 連線碼：wsUrl、netMode、NetClient、NetLobby、
                           LockstepEngine（逐 tick 輸入同步）、MatchRunner
  ai/                    — 決定性 bot：v1/…v5/ 版本快照、
                           common/（與 sim 對齊的感知層）、mapChampions.ts
  render/                — Pixi.js v8 渲染器 + 內插（在兩個 sim state 間內插）
  input/ ui/ config/ audio/ — 鍵盤、FeelPanel、FeelParams、音效
  spectate/              — bot vs bot 觀戰模式

server/
  main.py                — dev relay 入口（純 ws，預設 8765）
  serve.py               — 正式入口（HTTP static + ws relay）
  relay/                 — RelayServer、TickCoordinator、Lobby、Room（只中繼輸入，絕不跑 sim）
  tests/                 — pytest 測試

tools/sim-runner/        — headless 決定性測試 + AI bench（v3-bench、bt-rank、replay/golden）
scripts/serve.sh         — build + serve 便利腳本
docs/ai-versions.md      — 權威的 AI 版本狀態 / 強度 / 評估流程
```

> 決定性核心（`client/src/sim/`）是讓 lockstep 連線與 bot 補位成為可能的契約：
> 同 seed + 同逐 tick 輸入 ⇒ 每個 client 上 byte-identical 的 state。
