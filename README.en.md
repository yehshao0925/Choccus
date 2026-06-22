# Choccus（奶油啵啵爆）

> 🌐 **Language / 語言**：[中文（主要 / primary）](./README.md) ｜ **English (this page)**

A chocolate-and-cake-themed real-time online multiplayer game on a grid. Place
cakes, detonate them into a cross-shaped blast, and let the sticky cream trap
your opponents — then rescue teammates before time runs out.

> This file is the quick-start guide (install, run, deploy, test, architecture).
> The AI version status and eval flow lives in
> [`docs/ai-versions.md`](./docs/ai-versions.md).

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 + (tested on 25) |
| npm | 8 + (tested on 11) |
| Python | 3.11 + |

## Install

```sh
# 1. JavaScript dependencies (client + tools)
npm install

# 2. Python dependencies
python3 -m venv server/.venv
server/.venv/bin/pip install -r server/requirements.txt
```

---

## Dev mode (Vite + relay, hot-reload)

Open **two** terminals:

```sh
# Terminal 1 — WebSocket relay (default port 8765)
server/.venv/bin/python server/main.py

# Terminal 2 — Vite dev server (port 5173)
npm run dev
```

Open two browser tabs at `http://localhost:5173/?mode=net` and play.

### Solo / spectate (no relay needed)

The client also runs fully offline against deterministic AI bots:

| URL | Mode |
|-----|------|
| `http://localhost:5173/` | online lobby (default) |
| `http://localhost:5173/?mode=solo` | one human vs N AI bots (`&bots=`, `&difficulty=`, `&strategy=`) |
| `http://localhost:5173/?mode=spectate` | watch AI bots fight each other |

### Quick zero-click autoready (automated / CI)

```
http://localhost:5173/?mode=net&room=test&autoready=1
```

Open two tabs with that URL; they join the same room and start automatically.

Use `&port=<n>` to connect to a relay on a different port:

```
http://localhost:5173/?mode=net&room=test&autoready=1&port=9000
```

---

## Production / deploy mode

### 1. Build the client

```sh
npm run build
# → client/dist/  (static files ready to serve)
```

### 2. Start the production server

```sh
bash scripts/serve.sh
# or via npm:
npm run serve
```

This starts two services:

| Service | Default port | Configurable via |
|---------|-------------|-----------------|
| HTTP (static client) | **8080** | `CHOCCUS_STATIC_PORT` env or `--static-port` |
| WebSocket relay | **8765** | `CHOCCUS_PORT` env or `--port` |

Open `http://<server-ip>:8080/` in two browser tabs, click **Quick Match** (or
enter the same room name in both tabs), and the online match starts.

### Container (Docker / Podman)

The `Dockerfile` is multi-stage: Node builds `client/dist`, then a Python
runtime runs `serve.py` (static `:8080` + WS relay `:8765` in one process).

```sh
podman build -t choccus .          # or: docker build -t choccus .
podman run -d -p 8080:8080 -p 8765:8765 choccus
```

Pushing to `main` builds and publishes the image to GitHub Container Registry
via `.github/workflows/build-image.yml`:

```sh
podman pull ghcr.io/pttcodingman/choccus:latest
```

(The package starts private — pull with a PAT, or set it public once in the
repo's **Packages** settings.)

### How the WS URL is resolved (client)

The client resolves the relay URL automatically — no hardcoded `localhost`:

| URL parameter | Effect |
|---|---|
| `?ws=wss://example.com:8765` | explicit full URL override |
| `?port=9000` | `ws[s]://<same hostname>:9000` |
| _(none)_ | `ws[s]://<same hostname>:8765` (default) |

Uses `wss://` automatically when the page is served over HTTPS.

### Forcing a client rebuild before serving

```sh
bash scripts/serve.sh --rebuild
# or:
npm run serve:rebuild
```

### Split host/port setup (relay on a different host or behind a proxy)

Pass the full WS URL explicitly:

```
http://<static-host>:8080/?ws=wss://relay.example.com:8765
```

The invite link generated in-game preserves the `?ws=` parameter so friends
can click it directly.

### Reverse proxy (nginx / caddy)

If you put a TLS-terminating reverse proxy in front, configure it to:
- Serve `client/dist/` at `/` over HTTPS
- Proxy WebSocket connections at `/ws` (or a separate subdomain/port) to `ws://localhost:8765`

Then open the site over `https://` — the client automatically upgrades to `wss://`.

---

## Running tests

```sh
# Determinism / simulation / AI tests  (vitest: tsc --noEmit + golden hashes)
npm test

# Python relay server tests  (pytest)
server/.venv/bin/python -m pytest server/tests -q
```

> The AI bot benchmarks and eval flow (the various benches under
> `tools/sim-runner/`) are an internal development loop — not needed for
> self-hosting. See [`docs/ai-versions.md`](./docs/ai-versions.md) for the
> authoritative reference.

---

## Architecture overview

Monorepo: npm workspaces (`client` + `tools/sim-runner`) + a standalone Python relay.

```
shared/                  — code shared client⇄server: constants.ts, types.ts,
                           protocol.ts (1-byte MsgType + MessagePack wire format)

client/src/
  main.ts                — entry; URL ?mode= picks lobby (default) / solo / spectate
  sim/                   — deterministic, integer-only simulation core
                           (no Pixi/net/wall-clock; ESLint-guarded — keep it deterministic)
  net/                   — lockstep netcode: wsUrl, netMode, NetClient, NetLobby,
                           LockstepEngine (per-tick input sync), MatchRunner
  ai/                    — deterministic bots: v1/…v5/ version snapshots,
                           common/ (sim-aligned perception), mapChampions.ts
  render/                — Pixi.js v8 renderers + interpolation (renders between two sim states)
  input/ ui/ config/ audio/ — keyboard, FeelPanel, FeelParams, sound
  spectate/              — bot-vs-bot spectator mode

server/
  main.py                — dev relay entry point  (ws only, default 8765)
  serve.py               — production entry point (HTTP static + ws relay)
  relay/                 — RelayServer, TickCoordinator, Lobby, Room (relays input only, never runs the sim)
  tests/                 — pytest suite

tools/sim-runner/        — headless determinism tests + AI bench (v3-bench, bt-rank, replay/golden)
scripts/serve.sh         — build + serve convenience script
docs/ai-versions.md      — authoritative AI version status / strength / eval flow
```

> The deterministic core (`client/src/sim/`) is the contract that makes lockstep
> netcode and bot backfill possible: same seed + same per-tick inputs ⇒
> byte-identical state on every client.
