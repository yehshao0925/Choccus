"""Choccus production server.

Runs two services side-by-side:
  - WebSocket relay  (CHOCCUS_PORT, default 8765)
  - Static HTTP file server for client/dist/  (CHOCCUS_STATIC_PORT, default 8080)

Usage:
    python server/serve.py [--port 8765] [--static-port 8080] [--static-dir ./client/dist]

Environment variable overrides (all optional):
    CHOCCUS_HOST          WS bind host (default: 0.0.0.0)
    CHOCCUS_PORT          WS relay port (default: 8765)
    CHOCCUS_STATIC_PORT   HTTP static server port (default: 8080)
    CHOCCUS_STATIC_DIR    path to the built client directory (default: ../client/dist
                          relative to this file)

Two players can reach each other by opening the same HTTP URL in two browsers,
then using Quick Match or the same room name in the Lobby.

The WebSocket relay URL is auto-derived from the page origin (same hostname,
port CHOCCUS_PORT) by the client's wsUrl.ts resolver.  If you put a reverse
proxy in front (nginx/caddy) that terminates TLS and forwards both HTTP and
WS on port 443, the client will automatically use wss://.
"""

import argparse
import asyncio
import functools
import http.server
import os
import sys
import threading
from pathlib import Path

# Allow running from repo root or from server/
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from websockets.asyncio.server import serve as ws_serve

from relay.relay_server import RelayServer

try:
    import uvloop
except ImportError:
    uvloop = None

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
DEFAULT_HOST = os.environ.get("CHOCCUS_HOST", "0.0.0.0")
DEFAULT_WS_PORT = int(os.environ.get("CHOCCUS_PORT", "8765"))
DEFAULT_STATIC_PORT = int(os.environ.get("CHOCCUS_STATIC_PORT", "8080"))
DEFAULT_STATIC_DIR = Path(
    os.environ.get("CHOCCUS_STATIC_DIR", _HERE.parent / "client" / "dist")
)


# ---------------------------------------------------------------------------
# Static HTTP server (runs in a daemon thread)
# ---------------------------------------------------------------------------

class _SilentHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler that suppresses per-request log noise."""

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # silence access log


def _start_static_server(static_dir: Path, host: str, port: int) -> None:
    """Start the static HTTP server in a background daemon thread."""
    if not static_dir.is_dir():
        print(
            f"[choccus] WARNING: static dir '{static_dir}' does not exist — "
            "run 'npm run build --workspace @choccus/client' first.",
            flush=True,
        )
        return

    handler = functools.partial(_SilentHandler, directory=str(static_dir))
    httpd = http.server.HTTPServer((host, port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(
        f"[choccus] static server  → http://{host}:{port}/  (serving {static_dir})",
        flush=True,
    )


# ---------------------------------------------------------------------------
# WebSocket relay (runs in the asyncio event loop)
# ---------------------------------------------------------------------------

async def _run_relay(host: str, port: int) -> None:
    relay = RelayServer()
    loop_name = "uvloop" if uvloop is not None else "asyncio"
    # Relay frames are tiny (inputs/hashes + capped strings); 8 KiB is plenty
    # and far below the 1 MiB default, shrinking the per-frame OOM surface.
    async with ws_serve(relay.handler, host, port, max_size=8 * 1024):
        print(
            f"[choccus] relay server   → ws://{host}:{port}  ({loop_name})",
            flush=True,
        )
        await asyncio.get_running_loop().create_future()  # run forever


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Choccus production server (static HTTP + WS relay)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_WS_PORT,
        help=f"WebSocket relay port (default: {DEFAULT_WS_PORT})",
    )
    parser.add_argument(
        "--static-port",
        type=int,
        default=DEFAULT_STATIC_PORT,
        help=f"HTTP static server port (default: {DEFAULT_STATIC_PORT})",
    )
    parser.add_argument(
        "--static-dir",
        type=Path,
        default=DEFAULT_STATIC_DIR,
        help=f"Path to built client/dist/ directory (default: {DEFAULT_STATIC_DIR})",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Bind host for both servers (default: {DEFAULT_HOST})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    _start_static_server(args.static_dir, args.host, args.static_port)

    print(
        "[choccus] Two players: open the HTTP URL in two browser tabs, "
        "then use Quick Match or the same room name.",
        flush=True,
    )

    runner = uvloop.run if uvloop is not None else asyncio.run
    try:
        runner(_run_relay(args.host, args.port))
    except KeyboardInterrupt:
        print("\n[choccus] server stopped")


if __name__ == "__main__":
    main()
