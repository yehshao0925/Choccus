/**
 * NetClient: WebSocket transport for the lockstep relay (M4a/M5).
 *
 * Pure transport + typed dispatch — no game logic, no timing. Incoming
 * frames are decoded via protocolCodec and fanned out to typed listeners;
 * outgoing messages go through the typed sender methods below.
 *
 * M5 reconnect (socket-level only): with enableAutoReconnect(), an
 * UNEXPECTED close of a previously-open socket schedules reconnect attempts
 * with exponential backoff ('reconnecting' → 'reconnected' /
 * 'reconnectFailed'). Only the SOCKET is restored — the relay treats the
 * new connection as a brand-new client, so the app must re-join a room
 * afterwards. Mid-match session resume (state resync) is deliberately out
 * of scope; the other clients keep playing via the relay's ghost-input
 * handling. Calling close() never triggers reconnects.
 */
import {
  MsgType,
  buildAddBot,
  buildHashReport,
  buildInputFrame,
  buildJoinRoom,
  buildLeaveRoom,
  buildMatchResult,
  buildReadyToggle,
  buildRemoveBot,
  decodeServerMsg,
} from './protocolCodec';
import type { ServerMsg } from './protocolCodec';
import type {
  HashMismatchMsg,
  InputBroadcastMsg,
  MatchStartMsg,
  PlayerDisconnectMsg,
  RoomStateMsg,
  StallNoticeMsg,
  TickReadyMsg,
} from './protocolCodec';

/** Event name → payload map for NetClient.on(). */
export interface NetClientEvents {
  roomState: RoomStateMsg;
  matchStart: MatchStartMsg;
  inputBroadcast: InputBroadcastMsg;
  tickReady: TickReadyMsg;
  stallNotice: StallNoticeMsg;
  hashMismatch: HashMismatchMsg;
  playerDisconnect: PlayerDisconnectMsg;
  /** Any decoded server message (catch-all, fired in addition to the above). */
  message: ServerMsg;
  close: { code: number; reason: string };
  error: { message: string };
  /** Auto-reconnect lifecycle (only with enableAutoReconnect()). */
  reconnecting: { attempt: number; maxAttempts: number; delayMs: number };
  reconnected: { attempt: number };
  reconnectFailed: { attempts: number };
}

export interface ReconnectOptions {
  /** Give up after this many attempts (default 4). */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (default 500 ms). */
  baseDelayMs?: number;
  /** Backoff cap (default 8000 ms). */
  maxDelayMs?: number;
}

type Listener<K extends keyof NetClientEvents> = (
  payload: NetClientEvents[K],
) => void;

const CONNECT_TIMEOUT_MS = 5000;

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Map<
    keyof NetClientEvents,
    Set<Listener<keyof NetClientEvents>>
  >();

  // -- reconnect state (see header) --------------------------------------------
  private reconnect: Required<ReconnectOptions> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUrl: string | null = null;
  private intentionalClose = false;

  // -- events -----------------------------------------------------------------

  /** Subscribe to an event; returns an unsubscribe function. */
  on<K extends keyof NetClientEvents>(event: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(event);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener<keyof NetClientEvents>);
    return () => set.delete(fn as Listener<keyof NetClientEvents>);
  }

  private emit<K extends keyof NetClientEvents>(
    event: K,
    payload: NetClientEvents[K],
  ): void {
    const set = this.listeners.get(event);
    if (set === undefined) return;
    for (const fn of set) {
      (fn as Listener<K>)(payload);
    }
  }

  // -- connection -------------------------------------------------------------

  get isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Enable socket-level auto-reconnect on unexpected close. The relay has no
   * session resume: after 'reconnected' the app must joinRoom() again.
   */
  enableAutoReconnect(opts: ReconnectOptions = {}): void {
    this.reconnect = {
      maxAttempts: opts.maxAttempts ?? 4,
      baseDelayMs: opts.baseDelayMs ?? 500,
      maxDelayMs: opts.maxDelayMs ?? 8000,
    };
  }

  /** Open the socket; resolves on open, rejects on error or timeout. */
  connect(url: string, timeoutMs: number = CONNECT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let settled = false;
      let wasOpen = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error(`connect timeout after ${timeoutMs} ms (${url})`));
      }, timeoutMs);

      ws.onopen = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        wasOpen = true;
        this.ws = ws;
        this.lastUrl = url;
        this.intentionalClose = false;
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        this.emit('error', { message: `websocket error (${url})` });
        if (!settled) {
          settled = true;
          reject(new Error(`websocket error (${url})`));
        }
      };
      ws.onclose = (ev: CloseEvent) => {
        clearTimeout(timer);
        if (this.ws === ws) this.ws = null;
        this.emit('close', { code: ev.code, reason: ev.reason });
        if (!settled) {
          settled = true;
          reject(new Error(`socket closed during connect (code ${ev.code})`));
        } else if (wasOpen) {
          // Unexpected drop of an established socket (a failed reconnect
          // attempt never reaches here — its own catch drives the backoff).
          this.maybeScheduleReconnect();
        }
      };
      ws.onmessage = (ev: MessageEvent) => {
        this.handleFrame(ev.data as unknown);
      };
    });
  }

  close(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
  }

  private maybeScheduleReconnect(): void {
    if (
      this.intentionalClose ||
      this.reconnect === null ||
      this.reconnectTimer !== null ||
      this.lastUrl === null
    ) {
      return;
    }
    this.scheduleReconnect(1);
  }

  private scheduleReconnect(attempt: number): void {
    const opts = this.reconnect;
    const url = this.lastUrl;
    if (opts === null || url === null) return;
    if (attempt > opts.maxAttempts) {
      this.emit('reconnectFailed', { attempts: opts.maxAttempts });
      return;
    }
    const delayMs = Math.min(
      opts.baseDelayMs * 2 ** (attempt - 1),
      opts.maxDelayMs,
    );
    this.emit('reconnecting', {
      attempt,
      maxAttempts: opts.maxAttempts,
      delayMs,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.intentionalClose) return;
      this.connect(url).then(
        () => this.emit('reconnected', { attempt }),
        () => this.scheduleReconnect(attempt + 1),
      );
    }, delayMs);
  }

  // -- typed senders ------------------------------------------------------------

  /** roomId '' = create a new room. */
  joinRoom(roomId: string, name: string, playerId: string): void {
    this.send(buildJoinRoom(roomId, name, playerId));
  }

  reportResult(winnerTeam: number | null): void {
    this.send(buildMatchResult(winnerTeam));
  }

  leaveRoom(): void {
    this.send(buildLeaveRoom());
  }

  toggleReady(ready: boolean): void {
    this.send(buildReadyToggle(ready));
  }

  addBot(slot: number, difficulty: string): void {
    this.send(buildAddBot(slot, difficulty));
  }

  removeBot(slot: number): void {
    this.send(buildRemoveBot(slot));
  }

  sendInput(t: number, dirs: number, actions: number): void {
    this.send(buildInputFrame(t, dirs, actions));
  }

  sendHashReport(t: number, hash: number): void {
    this.send(buildHashReport(t, hash));
  }

  private send(frame: Uint8Array): void {
    if (!this.isOpen || this.ws === null) {
      console.warn('[net] send dropped: socket not open');
      return;
    }
    this.ws.send(frame);
  }

  // -- receive ------------------------------------------------------------------

  private handleFrame(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) {
      console.warn('[net] ignoring non-binary frame');
      return;
    }
    let msg: ServerMsg;
    try {
      msg = decodeServerMsg(new Uint8Array(data));
    } catch (err) {
      console.warn('[net] bad frame:', err);
      return;
    }
    this.emit('message', msg);
    switch (msg.type) {
      case MsgType.ROOM_STATE:
        this.emit('roomState', msg);
        break;
      case MsgType.MATCH_START:
        this.emit('matchStart', msg);
        break;
      case MsgType.INPUT_BROADCAST:
        this.emit('inputBroadcast', msg);
        break;
      case MsgType.TICK_READY:
        this.emit('tickReady', msg);
        break;
      case MsgType.STALL_NOTICE:
        this.emit('stallNotice', msg);
        break;
      case MsgType.HASH_MISMATCH:
        this.emit('hashMismatch', msg);
        break;
      case MsgType.PLAYER_DISCONNECT:
        this.emit('playerDisconnect', msg);
        break;
    }
  }
}
