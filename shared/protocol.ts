/**
 * Choccus — WebSocket lockstep protocol (type definitions only).
 *
 * Wire format: MessagePack payload prefixed by a 1-byte message-type id
 * (the `MsgType` values below). The Python relay mirrors these ids by hand;
 * this file is the single source of truth.
 *
 * No runtime logic lives here — encoding/decoding comes in M3/M4.
 */

import type { GamePhase } from './types';

// ---------------------------------------------------------------------------
// Message type ids (1-byte wire header). C→S: 0x01–0x0F, S→C: 0x10–0x1F.
// ---------------------------------------------------------------------------

export const MsgType = {
  // Client → Server
  JOIN_ROOM: 0x01,
  LEAVE_ROOM: 0x02,
  READY_TOGGLE: 0x03,
  INPUT_FRAME: 0x04,
  HASH_REPORT: 0x05,
  ADD_BOT: 0x06,
  REMOVE_BOT: 0x07,
  MATCH_RESULT: 0x08,

  // Server → Client
  ROOM_STATE: 0x10,
  MATCH_START: 0x11,
  INPUT_BROADCAST: 0x12,
  TICK_READY: 0x13,
  STALL_NOTICE: 0x14,
  HASH_MISMATCH: 0x15,
  PLAYER_DISCONNECT: 0x16,
} as const;
export type MsgType = (typeof MsgType)[keyof typeof MsgType];

// ---------------------------------------------------------------------------
// Shared payload pieces
// ---------------------------------------------------------------------------

/**
 * Feel parameters, sent by the server with MatchStart and frozen for the
 * whole match so every client simulates with identical values.
 */
export interface FeelParams {
  /** Tiles/s (3–8, default 5.0). */
  moveSpeed: number;
  /** Corner-assist tolerance in tiles (0–0.5, default 0.25). */
  cornerAssist: number;
  /** Input buffer in ms (0–250, default 120). */
  inputBufferMs: number;
}

/** One player's packed input for a single sim tick. */
export interface SlotInput {
  /** Direction bit flags (shared/types Direction). */
  dirs: number;
  /** Action bit flags (shared/types ActionFlags). */
  actions: number;
}

export interface RoomPlayer {
  slot: number;
  name: string;
  ready: boolean;
  connected: boolean;
  /** True = an AI bot filling this slot (no socket; driven client-side). */
  isBot?: boolean;
  /** Bot strength tier ('easy' | 'normal' | 'hard'); resolved to a BT rung
   *  per map on every client. Present only when isBot. */
  botDifficulty?: string;
  /** Conservative rating score (μ − 3σ); shown in the roster. */
  score?: number;
}

// ---------------------------------------------------------------------------
// Client → Server
// ---------------------------------------------------------------------------

export interface JoinRoomMsg {
  type: typeof MsgType.JOIN_ROOM;
  /** Room to join; empty string = create a new room. */
  roomId: string;
  name: string;
  /** Persistent client id (localStorage) — the rating key for this player. */
  playerId: string;
}

export interface LeaveRoomMsg {
  type: typeof MsgType.LEAVE_ROOM;
}

export interface ReadyToggleMsg {
  type: typeof MsgType.READY_TOGGLE;
  ready: boolean;
}

/** Add an AI bot to a specific empty slot (lobby only). */
export interface AddBotMsg {
  type: typeof MsgType.ADD_BOT;
  slot: number;
  /** Strength tier: 'easy' | 'normal' | 'hard' (default 'normal'). */
  difficulty: string;
}

/** Remove a bot from a slot (lobby only). */
export interface RemoveBotMsg {
  type: typeof MsgType.REMOVE_BOT;
  slot: number;
}

/**
 * Reported by clients when the sim reaches OVER: the winning team (= winning
 * slot in the current FFA setup), or null for a draw. The relay never
 * simulates, so this is how it learns the outcome — backed by lockstep hash
 * agreement, and applied once per match.
 */
export interface MatchResultMsg {
  type: typeof MsgType.MATCH_RESULT;
  winnerTeam: number | null;
}

/** Local input sampled at tick t, scheduled for sim tick t + INPUT_DELAY_TICKS. */
export interface InputFrameMsg {
  type: typeof MsgType.INPUT_FRAME;
  /** Target sim tick this input applies to. */
  t: number;
  dirs: number;
  actions: number;
}

/** Sent every HASH_REPORT_INTERVAL ticks for desync detection. */
export interface HashReportMsg {
  type: typeof MsgType.HASH_REPORT;
  t: number;
  /** FNV-1a state hash (uint32). */
  hash: number;
}

export type ClientMsg =
  | JoinRoomMsg
  | LeaveRoomMsg
  | ReadyToggleMsg
  | AddBotMsg
  | RemoveBotMsg
  | MatchResultMsg
  | InputFrameMsg
  | HashReportMsg;

// ---------------------------------------------------------------------------
// Server → Client
// ---------------------------------------------------------------------------

export interface RoomStateMsg {
  type: typeof MsgType.ROOM_STATE;
  roomId: string;
  phase: GamePhase;
  /** Receiver's own slot index. */
  youSlot: number;
  players: RoomPlayer[];
}

export interface MatchStartMsg {
  type: typeof MsgType.MATCH_START;
  /** Shared PRNG seed (uint32) — map and drops all derive from it. */
  seed: number;
  /** Receiver's player slot. */
  slot: number;
  /** Frozen feel parameters for the whole match. */
  config: FeelParams;
  /** First sim tick (clients start stepping from here). */
  t0: number;
}

/** All slots' inputs for sim tick t; clients only step once a tick is complete. */
export interface InputBroadcastMsg {
  type: typeof MsgType.INPUT_BROADCAST;
  t: number;
  /** Indexed by slot. */
  inputs: SlotInput[];
}

export interface TickReadyMsg {
  type: typeof MsgType.TICK_READY;
  t: number;
}

/** Inputs missing for tick t beyond STALL_TIMEOUT_MS; display "waiting". */
export interface StallNoticeMsg {
  type: typeof MsgType.STALL_NOTICE;
  t: number;
  /** Slots the server is still waiting on. */
  waiting: number[];
}

/** Desync detected (v1: detection only — clients end the match gracefully). */
export interface HashMismatchMsg {
  type: typeof MsgType.HASH_MISMATCH;
  t: number;
  /** Reported hash per slot (uint32), indexed by slot. */
  hashes: number[];
}

/** From here on this slot is driven by ghost input (repeat last input). */
export interface PlayerDisconnectMsg {
  type: typeof MsgType.PLAYER_DISCONNECT;
  slot: number;
}

export type ServerMsg =
  | RoomStateMsg
  | MatchStartMsg
  | InputBroadcastMsg
  | TickReadyMsg
  | StallNoticeMsg
  | HashMismatchMsg
  | PlayerDisconnectMsg;
