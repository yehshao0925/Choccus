/**
 * NetLobby: pre-match state machine on top of NetClient (M5).
 *
 * Persistent — it lives across matches, tracking the connection / room /
 * match phase and the latest roster snapshot. LobbyUI renders this state;
 * netMode orchestrates (UI events → lobby actions, lobby events → screens).
 *
 * Phases:
 *   idle → connecting → connected → joining → room → started
 *                                      ↑________________|   (rematch: the
 *   relay resets the room to LOBBY on the first post-match ReadyToggle, so
 *   a RoomState with phase=LOBBY while 'started' drops us back to 'room')
 *   closed: socket gone (reconnect is handled by NetClient/netMode).
 *
 * NOTE: the relay has no error/NACK message — an invalid join (full room,
 * room mid-match) is silently ignored server-side, so joinAndWait() resolves
 * the success case via the first RoomState and turns the silent failure into
 * a timeout rejection.
 */
import { GamePhase } from '../../../shared/types';
import type { NetClient } from './NetClient';
import type { MatchStartMsg, RoomStateMsg } from './protocolCodec';

export type NetLobbyPhase =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'joining'
  | 'room'
  | 'started'
  | 'closed';

const JOIN_TIMEOUT_MS = 4000;

export class NetLobby {
  phase: NetLobbyPhase = 'idle';
  /** Latest roster snapshot (null while not in a room). */
  roomState: RoomStateMsg | null = null;
  /** Persistent rating key sent with every join (set by the orchestrator). */
  playerId = '';

  onPhase?: (phase: NetLobbyPhase) => void;
  onRoomState?: (msg: RoomStateMsg) => void;
  onMatchStart?: (msg: MatchStartMsg) => void;

  constructor(private readonly client: NetClient) {
    client.on('roomState', (msg) => {
      this.roomState = msg;
      if (
        this.phase === 'joining' ||
        (this.phase === 'started' && msg.phase === GamePhase.LOBBY)
      ) {
        this.setPhase('room');
      }
      this.onRoomState?.(msg);
    });
    client.on('matchStart', (msg) => {
      this.setPhase('started');
      this.onMatchStart?.(msg);
    });
    client.on('close', () => {
      this.roomState = null;
      this.setPhase('closed');
    });
    client.on('reconnected', () => {
      // Socket restored, but the relay forgot us — back to roomless.
      this.roomState = null;
      this.setPhase('connected');
    });
  }

  /** The local player's roster entry (from the latest RoomState). */
  get localPlayer(): RoomStateMsg['players'][number] | null {
    const state = this.roomState;
    return state?.players.find((p) => p.slot === state.youSlot) ?? null;
  }

  async connect(url: string): Promise<void> {
    this.setPhase('connecting');
    try {
      await this.client.connect(url);
    } catch (err) {
      this.setPhase('closed');
      throw err;
    }
    this.setPhase('connected');
  }

  /** Fire-and-forget join; roomId '' = create a new random-id room. */
  join(roomId: string, name: string): void {
    this.setPhase('joining');
    this.client.joinRoom(roomId, name, this.playerId);
  }

  /**
   * Join and wait for the confirming RoomState. Rejects on timeout (the
   * relay silently ignores joins into full / mid-match rooms) or close.
   */
  joinAndWait(
    roomId: string,
    name: string,
    timeoutMs: number = JOIN_TIMEOUT_MS,
  ): Promise<RoomStateMsg> {
    return new Promise((resolve, reject) => {
      const offs: Array<() => void> = [];
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error('join timed out — the room may be mid-match or full'),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        for (const off of offs) off();
      };
      offs.push(
        this.client.on('roomState', (msg) => {
          cleanup();
          resolve(msg);
        }),
        this.client.on('close', (ev) => {
          cleanup();
          reject(new Error(`connection closed while joining (code ${ev.code})`));
        }),
      );
      this.join(roomId, name);
    });
  }

  leave(): void {
    this.client.leaveRoom();
    this.roomState = null;
    this.setPhase('connected');
  }

  setReady(ready: boolean): void {
    this.client.toggleReady(ready);
  }

  addBot(slot: number, difficulty: string): void {
    this.client.addBot(slot, difficulty);
  }

  removeBot(slot: number): void {
    this.client.removeBot(slot);
  }

  private setPhase(phase: NetLobbyPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    this.onPhase?.(phase);
  }
}
