"""Choccus relay server entry point.

Pure deterministic-lockstep relay: rooms/lobby, shared match seed, per-tick
input relaying (see server/relay/). The server never runs game logic.

Configuration via environment:
  CHOCCUS_HOST  bind host (default: localhost)
  CHOCCUS_PORT  bind port (default: 8765)
"""

import asyncio
import os

from websockets.asyncio.server import serve

from relay.relay_server import RelayServer

try:  # optional event-loop speedup; pure stdlib asyncio works fine too
    import uvloop
except ImportError:
    uvloop = None

HOST = os.environ.get("CHOCCUS_HOST", "localhost")
PORT = int(os.environ.get("CHOCCUS_PORT", "8765"))


async def main() -> None:
    relay = RelayServer()
    # Relay frames are tiny (inputs/hashes + capped strings); 8 KiB is plenty
    # and far below the 1 MiB default, shrinking the per-frame OOM surface.
    async with serve(relay.handler, HOST, PORT, max_size=8 * 1024):
        loop = "uvloop" if uvloop is not None else "asyncio"
        print(
            f"[choccus] relay server listening on ws://{HOST}:{PORT} ({loop})",
            flush=True,
        )
        await asyncio.get_running_loop().create_future()  # run forever


if __name__ == "__main__":
    runner = uvloop.run if uvloop is not None else asyncio.run
    try:
        runner(main())
    except KeyboardInterrupt:
        print("[choccus] server stopped")
