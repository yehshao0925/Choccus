/**
 * M5 net mode orchestrator: lobby screens → lockstep match → result/rematch,
 * plus disconnect/reconnect handling.
 *
 * URL params (all optional):
 *   ?mode=net          select this path (main.ts)
 *   &room=test         room id (auto-created server-side if missing)
 *   &name=p1           player name (room + name together = deep link that
 *                      joins the room view with zero clicks)
 *   &autoready=1       legacy zero-click path: auto-join + auto-ready once
 *                      ≥2 players are in the room (used by automated tests)
 *   &port=8765         relay port (default 8765, env CHOCCUS_PORT server-side)
 *   &debug=1           show the NetDebugOverlay (implied by autoready=1)
 *
 * Flow: LobbyUI (DOM screens, view) is driven by NetLobby (state) and this
 * orchestrator; each MatchStart spins up a MatchRunner (engine + rAF loop).
 * Rematch: the relay resets a PLAYING room to LOBBY on the first post-match
 * ReadyToggle, so "Rematch" simply readies up again → fresh MatchStart with
 * a new seed.
 *
 * Reconnect limitation (documented; resync is post-M5): NetClient restores
 * only the SOCKET after a drop. The relay has no session resume, so a client
 * that loses its connection mid-match cannot rejoin that match — it lands on
 * a "disconnected" screen and re-enters via the lobby (the room itself stays
 * playable for the others through the relay's ghost-input handling; the
 * room becomes joinable again after the survivors trigger a rematch reset).
 */
import { KeyboardInput } from '../input/KeyboardInput';
import { Renderer } from '../render/Renderer';
import { LobbyUI } from './LobbyUI';
import { MatchRunner } from './MatchRunner';
import { NetClient } from './NetClient';
import { NetDebugOverlay } from './NetDebugOverlay';
import { NetLobby } from './NetLobby';
import { resolveWsUrl } from './wsUrl';
import type { LockstepStatus } from './LockstepEngine';
import type { MatchStartMsg, RoomPlayer, RoomStateMsg } from './protocolCodec';

/** autoready waits for this roster size before readying up. */
const AUTOREADY_MIN_PLAYERS = 2;

type Screen = 'landing' | 'room' | 'match' | 'result' | 'disconnected';

export async function runNetMode(params: URLSearchParams): Promise<void> {
  const url = resolveWsUrl(params);
  const roomParam = params.get('room') ?? '';
  const nameParam = params.get('name') ?? '';
  const autoReady = params.get('autoready') === '1';
  const debug = autoReady || params.get('debug') === '1';
  const name =
    nameParam ||
    `Player${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;

  const mount = document.getElementById('app');
  if (!mount) {
    throw new Error('#app mount point missing');
  }

  const client = new NetClient();
  client.enableAutoReconnect();
  const lobby = new NetLobby(client);
  const keyboard = new KeyboardInput(); // attached only while a match runs

  const ui = new LobbyUI();
  mount.appendChild(ui.root);
  ui.setName(name);
  ui.setRoomId(roomParam);
  // Invite link deliberately omits `name` so the friend picks their own.
  ui.buildInviteUrl = (roomId) => {
    const u = new URL(window.location.href);
    u.search = '';
    u.searchParams.set('mode', 'net');
    u.searchParams.set('room', roomId);
    if (params.has('ws')) u.searchParams.set('ws', params.get('ws')!);
    else if (params.has('port')) u.searchParams.set('port', params.get('port')!);
    return u.toString();
  };

  let overlay: NetDebugOverlay | null = null;
  if (debug) {
    overlay = new NetDebugOverlay();
    // Top-right so the panel does not cover the arena (canvas mounts left).
    overlay.root.style.left = 'auto';
    overlay.root.style.right = '8px';
    document.body.appendChild(overlay.root);
    client.on('stallNotice', (m) =>
      overlay?.log(`StallNotice t=${m.t} waiting=[${m.waiting.join(',')}]`),
    );
    client.on('hashMismatch', (m) =>
      overlay?.log(`HashMismatch t=${m.t} hashes=[${m.hashes.join(',')}]`),
    );
    client.on('playerDisconnect', (m) =>
      overlay?.log(`PlayerDisconnect slot=${m.slot}`),
    );
    client.on('error', (ev) => overlay?.log(`error: ${ev.message}`));
    lobby.onPhase = (phase) =>
      overlay?.setStatus(`${phase} · ${url} · name=${name}`);
  }

  let screen: Screen = 'landing';
  let renderer: Renderer | null = null;
  let runner: MatchRunner | null = null;
  /** Roster snapshot at MatchStart — names disconnect notices by slot. */
  let rosterAtStart: RoomPlayer[] = [];
  let everConnected = false;
  let lastRoomId = roomParam;

  const errText = (err: unknown): string =>
    err instanceof Error ? err.message : String(err);

  const stopRunner = (): void => {
    runner?.stop();
    runner = null;
    ui.setMatchNotice(null);
    if (renderer !== null) renderer.canvas.style.display = 'none';
  };

  // -- lobby events → screens ---------------------------------------------------

  lobby.onRoomState = (state: RoomStateMsg): void => {
    overlay?.setRoomState(state);
    lastRoomId = state.roomId;
    if (screen === 'room') {
      ui.showRoom(state);
    } else if (screen === 'result') {
      // Someone pressed Rematch: the room is back in LOBBY — show progress.
      const ready = state.players.filter((p) => p.connected && p.ready).length;
      const present = state.players.filter((p) => p.connected).length;
      ui.setResultStatus(
        present < 2
          ? 'Waiting for another player to join the room…'
          : `Rematch: ${ready}/${present} ready…`,
      );
    }
  };

  lobby.onMatchStart = (start: MatchStartMsg): void => {
    void startMatch(start);
  };

  async function startMatch(start: MatchStartMsg): Promise<void> {
    overlay?.setMatchStart(start);
    overlay?.log(`MatchStart seed=${start.seed} slot=${start.slot} t0=${start.t0}`);

    // numPlayers = highest occupied slot + 1 from the last RoomState (the
    // roster is identical on every client at MatchStart, so this stays
    // deterministic; it also matches the relay's InputBroadcast width).
    rosterAtStart = lobby.roomState?.players ?? [];
    const numPlayers =
      Math.max(start.slot, ...rosterAtStart.map((p) => p.slot)) + 1;

    if (renderer === null) {
      renderer = await Renderer.create();
      mount?.appendChild(renderer.canvas);
    }
    renderer.setHudHint(
      `Online — you are P${start.slot + 1} · Arrows + Space`,
      false,
    );
    renderer.canvas.style.display = '';

    runner?.stop();
    screen = 'match';
    ui.showMatch();
    ui.setMatchNotice(null);
    runner = new MatchRunner({
      client,
      start,
      numPlayers,
      renderer,
      keyboard,
      onStatus: (s) => updateMatchStatus(s),
      onOver: (result) => {
        screen = 'result';
        const detail =
          result === 'win'
            ? 'Your team is the last standing!'
            : result === 'draw'
              ? "Time up — it's a draw."
              : 'Your team was eliminated…';
        ui.showResult(result, detail);
      },
    });
  }

  function updateMatchStatus(s: LockstepStatus): void {
    if (overlay !== null) {
      const hash =
        s.lastHashTick >= 0
          ? `0x${s.lastHash.toString(16).padStart(8, '0')} @ t${s.lastHashTick}`
          : '(none yet)';
      const lines = [
        `you are slot ${s.mySlot} (Arrows + Space) · players ${s.numPlayers}`,
        `tick ${s.currentTick} · hash ${hash}`,
      ];
      if (s.desynced) {
        lines.push(`*** DESYNC at t=${s.lastMismatch?.t ?? '?'} — match frozen ***`);
      } else if (s.stalled) {
        lines.push(
          `waiting for inputs…${
            s.stallWaiting.length > 0 ? ` (slots ${s.stallWaiting.join(',')})` : ''
          }`,
        );
      }
      if (s.disconnectedSlots.length > 0) {
        lines.push(`disconnected slots: ${s.disconnectedSlots.join(',')}`);
      }
      overlay.setLockstep(lines.join('\n'));
    }

    const slotName = (slot: number): string => {
      const p = rosterAtStart.find((r) => r.slot === slot);
      return p?.name ? `${p.name} (P${slot + 1})` : `P${slot + 1}`;
    };
    const notices: string[] = [];
    if (s.desynced) {
      notices.push('Desync detected — match frozen (cannot resync in this build)');
    } else if (s.stalled && s.stallWaiting.length > 0) {
      notices.push(
        `Waiting for ${s.stallWaiting.map(slotName).join(', ')}…`,
      );
    }
    if (s.disconnectedSlots.length > 0) {
      notices.push(
        `${s.disconnectedSlots.map(slotName).join(', ')} disconnected`,
      );
    }
    ui.setMatchNotice(notices.length > 0 ? notices.join(' · ') : null);
  }

  // -- UI events → lobby actions ---------------------------------------------------

  const ensureConnected = async (): Promise<void> => {
    if (!client.isOpen) {
      await lobby.connect(url);
      everConnected = true;
    }
  };

  const joinFlow = async (playerName: string, roomId: string): Promise<void> => {
    ui.setLandingStatus('Connecting…');
    try {
      await ensureConnected();
      const state = await lobby.joinAndWait(roomId, playerName);
      lastRoomId = state.roomId;
      screen = 'room';
      ui.showRoom(state);
    } catch (err) {
      screen = 'landing';
      ui.showLanding(`Could not join: ${errText(err)}`);
    }
  };

  ui.onCreateRoom = (n) => void joinFlow(n, '');
  ui.onJoinRoom = (n, roomId) => void joinFlow(n, roomId);
  ui.onQuickMatch = (n) => void joinFlow(n, 'test');
  ui.onReadyToggle = (ready) => lobby.setReady(ready);
  ui.onLeaveRoom = () => {
    lobby.leave();
    screen = 'landing';
    ui.showLanding();
    ui.setRoomId(lastRoomId);
  };
  ui.onRematch = () => {
    // The relay resets the room to LOBBY on this toggle (rematch signal).
    lobby.setReady(true);
    ui.setResultStatus('Ready — waiting for the other player…');
  };
  ui.onBackToRoom = () => {
    stopRunner();
    lobby.setReady(false); // also resets the room if we're the first one back
    screen = 'room';
    if (lobby.roomState !== null) ui.showRoom(lobby.roomState);
  };
  ui.onSolo = () => {
    // Offline practice: reload into the single-player route (no WS).
    const u = new URL(window.location.href);
    u.search = '?mode=solo';
    window.location.assign(u.toString());
  };
  ui.onReconnect = () => {
    void (async () => {
      ui.showDisconnected('Reconnecting…', false);
      try {
        await ensureConnected();
        screen = 'landing';
        ui.showLanding('Reconnected — rejoin a room to play.');
        ui.setRoomId(lastRoomId);
      } catch (err) {
        ui.showDisconnected(`Still unreachable: ${errText(err)}`, true);
      }
    })();
  };

  // -- connection loss / reconnect ---------------------------------------------------

  client.on('close', (ev) => {
    overlay?.setStatus(
      `disconnected (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`,
    );
    if (!everConnected) return; // initial connect failure: joinFlow reports it
    if (screen === 'disconnected') return; // failed retry: reconnect events drive the UI
    stopRunner();
    screen = 'disconnected';
    ui.showDisconnected('Connection to the server was lost.', true);
  });
  client.on('reconnecting', (info) => {
    if (screen !== 'disconnected') return;
    ui.showDisconnected(
      `Connection lost — reconnecting (attempt ${info.attempt}/${info.maxAttempts})…`,
      false,
    );
  });
  client.on('reconnected', () => {
    overlay?.setStatus('reconnected');
    if (screen !== 'disconnected') return;
    // No mid-match resume (see header) — back in via the lobby.
    screen = 'landing';
    ui.showLanding(
      'Reconnected — matches in progress cannot be rejoined; enter a room to play.',
    );
    ui.setRoomId(lastRoomId);
  });
  client.on('reconnectFailed', () => {
    if (screen !== 'disconnected') return;
    ui.showDisconnected(
      'Could not reconnect automatically — the server may be down.',
      true,
    );
  });

  // -- entry --------------------------------------------------------------------------

  if (autoReady) {
    // Legacy zero-click path (automated tests): join + ready, no UI clicks.
    screen = 'match';
    ui.showMatch();
    try {
      await ensureConnected();
      let readySent = false;
      client.on('roomState', (m) => {
        if (!readySent && m.players.length >= AUTOREADY_MIN_PLAYERS) {
          readySent = true;
          client.toggleReady(true);
        }
      });
      lobby.join(roomParam, name);
    } catch (err) {
      overlay?.setStatus(`failed: ${errText(err)}`);
      screen = 'landing';
      ui.showLanding(`Could not connect: ${errText(err)}`);
    }
  } else if (roomParam !== '' && nameParam !== '') {
    // Deep link with an explicit name: straight into the room view.
    void joinFlow(name, roomParam);
  } else {
    screen = 'landing';
    ui.showLanding();
  }
}
