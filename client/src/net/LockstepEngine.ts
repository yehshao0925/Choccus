/**
 * LockstepEngine: the networked match loop (M4b).
 *
 * Owns the deterministic sim during an online match and advances it in
 * lockstep with the relay:
 *
 * - Local input sampled for sim tick T is scheduled for tick
 *   T + INPUT_DELAY_TICKS, stored locally AND sent to the relay (the relay
 *   echoes it back inside the slot-indexed InputBroadcast — the
 *   authoritative copy, identical for every client).
 * - A tick only advances once inputs for ALL slots of `currentTick` are
 *   buffered; otherwise the accumulator holds (freeze) until the missing
 *   InputBroadcast arrives. The relay emits StallNotice meanwhile.
 * - Ticks t0 .. t0+INPUT_DELAY_TICKS-1 are pre-seeded with NO_INPUT for all
 *   slots (standard lockstep warmup) so the first delayed inputs can land.
 * - Every HASH_REPORT_INTERVAL ticks the post-tick stateHash is reported;
 *   a HashMismatch from the relay freezes the match (M4b policy — full
 *   resync is post-M5).
 *
 * Field mapping (easy to get wrong): the sim's InputFrame uses `dir`/`action`
 * (sim/InputBuffer.ts); the wire SlotInput uses `dirs`/`actions`
 * (shared/protocol.ts). This class is the only place that converts.
 *
 * Disconnect / ghost input: on PlayerDisconnect the relay stops REQUIRING
 * that slot but keeps including it in every InputBroadcast (buffered real
 * frames first, then neutral fill — see server/relay/tick_coordinator.py).
 * We deliberately consume the broadcast VERBATIM instead of substituting a
 * client-side "repeat last input" ghost: PlayerDisconnect delivery is not
 * tick-synchronized, so any substitution keyed on its arrival would apply
 * from different ticks on different clients and desync them. The broadcast
 * is identical for everyone — using it verbatim is the deterministic ghost
 * (the slot simply goes neutral). `disconnectedSlots` is kept for the HUD.
 *
 * Timing lives HERE (net/), never in sim/: the caller drives `update(dtMs)`
 * from rAF (or any clock) and renders via `getRenderStates()`.
 */
import {
  HASH_REPORT_INTERVAL,
  INPUT_DELAY_TICKS,
  TICK_MS,
} from '../../../shared/constants';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../ai/index';
import { asTier, botForTier } from '../ai/botDifficulty';
import { type FeelParams, makeFeelParams } from '../config/FeelParams';
import { type InputFrame, NO_INPUT } from '../sim/InputBuffer';
import { spawnOrderFromSeed } from '../sim/Map';
import { type SimState, createInitialState, tick } from '../sim/Sim';
import type { NetClient } from './NetClient';
import type {
  HashMismatchMsg,
  MatchStartMsg,
  SlotInput,
  StallNoticeMsg,
} from './protocolCodec';

/** Clamp on a single update() delta (tab switch, breakpoint, bg throttle). */
const MAX_UPDATE_DT_MS = 1000;
/** Clamp on the accumulator while blocked — caps the post-stall burst. */
const MAX_ACC_MS = 2000;

export interface LockstepEngineOptions {
  client: NetClient;
  start: MatchStartMsg;
  /**
   * Slot count of the match = highest occupied slot + 1 from the LAST
   * RoomState before MatchStart (MatchStart itself does not carry a roster;
   * the roster is identical on every client at start, so this stays
   * deterministic). Must match the relay's InputBroadcast array width.
   */
  numPlayers: number;
  /** Sample the LOCAL player's raw input for the given target sim tick. */
  sampleLocalInput: (forTick: number) => InputFrame;
  /**
   * Slots filled by AI bots (from the RoomState roster), each with its chosen
   * strength tier. Bots have no socket — every client runs them locally and
   * deterministically: createBot(seed, slot, …) + the byte-identical lockstep
   * state guarantee an identical input sequence on every client, so no bot data
   * crosses the wire and the relay never waits on these slots. The tier maps to
   * the same BT rung on every client (botDifficulty.ts).
   */
  bots?: ReadonlyArray<{ slot: number; difficulty: string }>;
  /** Fired after every advanced tick with the post-tick uint32 hash. */
  onTick?: (tickNo: number, hash: number) => void;
}

/** Snapshot for the HUD/overlay — read, never mutate. */
export interface LockstepStatus {
  currentTick: number;
  mySlot: number;
  numPlayers: number;
  /** True while the accumulator is blocked waiting for remote inputs. */
  stalled: boolean;
  /** Slots the relay reported as missing in the last StallNotice. */
  stallWaiting: readonly number[];
  desynced: boolean;
  lastMismatch: HashMismatchMsg | null;
  /** Tick of the last hash report sent (uint32 hash alongside). */
  lastHashTick: number;
  lastHash: number;
  disconnectedSlots: readonly number[];
}

export class LockstepEngine {
  private readonly client: NetClient;
  private readonly numPlayers: number;
  private readonly mySlot: number;
  private readonly sampleLocalInput: (forTick: number) => InputFrame;
  private readonly onTick: ((tickNo: number, hash: number) => void) | undefined;

  /** Next sim tick to produce (sim has advanced through currentTick - 1). */
  private currentTick: number;
  /** Target tick of the next local InputFrame to schedule/send. */
  private nextSendTick: number;
  private prevState: SimState;
  private curState: SimState;

  /** tick → slot → wire input. Pre-seeded for the warmup window. */
  private readonly pendingInputs = new Map<number, Map<number, SlotInput>>();

  /** Bot brains for the bot slots; their input is computed locally per tick. */
  private readonly botSlots: Set<number>;
  private readonly bots = new Map<number, IBotController>();

  private acc = 0;
  private blocked = false;
  private desynced = false;
  private lastMismatch: HashMismatchMsg | null = null;
  private lastStall: StallNoticeMsg | null = null;
  private lastHashTick = -1;
  private lastHash = 0;
  private readonly disconnected = new Set<number>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(opts: LockstepEngineOptions) {
    this.client = opts.client;
    this.numPlayers = opts.numPlayers;
    this.mySlot = opts.start.slot;
    this.sampleLocalInput = opts.sampleLocalInput;
    this.onTick = opts.onTick;

    // The wire config (shared/protocol.ts FeelParams) and the client config
    // (config/FeelParams.ts) now share identical field names, so the MatchStart
    // config feeds makeFeelParams directly — no hand-map to drift.
    const feel: FeelParams = makeFeelParams(opts.start.config);
    // team = slot (teams omitted → default). Computed identically on every
    // client from the shared seed + roster width, so it never diverges. The
    // spawn-corner permutation is likewise derived purely from the shared seed,
    // so every client agrees on it with no extra wire data (no desync).
    this.curState = createInitialState(opts.start.seed, feel, this.numPlayers, {
      pvp: true,
      spawnOrder: spawnOrderFromSeed(opts.start.seed),
    });
    this.prevState = this.curState;
    this.currentTick = opts.start.t0;
    this.nextSendTick = opts.start.t0 + INPUT_DELAY_TICKS;

    // Build a bot brain per bot slot from its chosen tier. The tier → BT rung
    // (version, archetype) mapping is identical on every client for the rolled
    // map + seed, so every client builds the same bot → no desync, no bot data
    // on the wire. Strength = which archetype (played at full strength), so
    // strategyRaw carries the archetype and difficulty stays 'champion'.
    this.botSlots = new Set((opts.bots ?? []).map((b) => b.slot));
    for (const { slot, difficulty } of opts.bots ?? []) {
      const rung = botForTier(asTier(difficulty), this.curState.mapKind);
      const module = AI_VERSIONS[rung.version];
      if (module !== undefined) {
        const spec: BotSpec = { difficulty: 'champion', strategyRaw: rung.archetype };
        this.bots.set(slot, module.createBot(opts.start.seed, slot, spec));
      }
    }

    // Lockstep warmup: the first INPUT_DELAY_TICKS ticks run on NO_INPUT for
    // every slot (the relay only ever relays ticks >= t0 + INPUT_DELAY_TICKS).
    for (let t = opts.start.t0; t < opts.start.t0 + INPUT_DELAY_TICKS; t++) {
      const bySlot = new Map<number, SlotInput>();
      for (let slot = 0; slot < this.numPlayers; slot++) {
        bySlot.set(slot, { dirs: NO_INPUT.dir, actions: NO_INPUT.action });
      }
      this.pendingInputs.set(t, bySlot);
    }

    this.unsubscribers.push(
      this.client.on('inputBroadcast', (m) => {
        if (m.t < this.currentTick) return; // late echo for a done tick
        const bySlot =
          this.pendingInputs.get(m.t) ?? new Map<number, SlotInput>();
        for (let slot = 0; slot < m.inputs.length; slot++) {
          // Bot slots carry neutral filler in the broadcast — ignore it; the
          // bot's real input is computed locally in tryAdvanceTick().
          if (this.botSlots.has(slot)) continue;
          const input = m.inputs[slot];
          if (input !== undefined) bySlot.set(slot, input);
        }
        this.pendingInputs.set(m.t, bySlot);
      }),
      this.client.on('hashMismatch', (m) => {
        if (this.desynced) return; // fire recovery once
        this.desynced = true;
        this.lastMismatch = m;
        console.error(
          `[lockstep] DESYNC at tick ${m.t}: hashes=[${m.hashes
            .map((h) => `0x${(h >>> 0).toString(16).padStart(8, '0')}`)
            .join(', ')}] — returning to lobby (resync is post-M5)`,
        );
        // ponytail: recovery ceiling = reload back to the lobby, NOT rollback /
        // state-resync netcode. update() already early-returns forever once
        // desynced (dead canvas); a hard reload to ?mode=net drops the player on
        // a fresh lobby so they aren't stuck on a frozen match.
        this.stop();
        const u = new URL(window.location.href);
        u.search = '?mode=net';
        window.location.assign(u.toString());
      }),
      this.client.on('stallNotice', (m) => {
        this.lastStall = m;
      }),
      this.client.on('playerDisconnect', (m) => {
        // Informational only — see the ghost-input note in the header.
        this.disconnected.add(m.slot);
      }),
    );
  }

  // -- main loop ----------------------------------------------------------------

  /**
   * Fixed-timestep accumulator step. Call once per animation frame (or from
   * any wall clock); advances zero or more sim ticks depending on elapsed
   * time AND input availability.
   */
  update(dtMs: number): void {
    if (this.desynced) return;
    this.acc += Math.min(Math.max(dtMs, 0), MAX_UPDATE_DT_MS);
    this.blocked = false;
    while (this.acc >= TICK_MS) {
      if (!this.tryAdvanceTick()) {
        this.blocked = true;
        if (this.acc > MAX_ACC_MS) this.acc = MAX_ACC_MS;
        return;
      }
      this.acc -= TICK_MS;
    }
  }

  /** Advance exactly one sim tick if every slot's input is buffered. */
  private tryAdvanceTick(): boolean {
    const t = this.currentTick;

    // Schedule + send the local input for t + INPUT_DELAY_TICKS exactly once
    // per produced tick (matches the relay's expected cadence: first frame at
    // t0 + INPUT_DELAY_TICKS, one per tick after that).
    if (t + INPUT_DELAY_TICKS === this.nextSendTick) {
      const frame = this.sampleLocalInput(this.nextSendTick);
      let bySlot = this.pendingInputs.get(this.nextSendTick);
      if (bySlot === undefined) {
        bySlot = new Map<number, SlotInput>();
        this.pendingInputs.set(this.nextSendTick, bySlot);
      }
      bySlot.set(this.mySlot, { dirs: frame.dir, actions: frame.action });
      this.client.sendInput(this.nextSendTick, frame.dir, frame.action);
      this.nextSendTick += 1;
    }

    // Fill bot slots locally from the current (byte-identical) state. Each bot
    // is sampled exactly once per tick (guarded by has()), so its internal RNG
    // advances identically on every client → no desync. Warmup ticks already
    // hold NO_INPUT for bot slots, so bots first act at t0 + INPUT_DELAY_TICKS.
    if (this.bots.size > 0) {
      let bots = this.pendingInputs.get(t);
      if (bots === undefined) {
        bots = new Map<number, SlotInput>();
        this.pendingInputs.set(t, bots);
      }
      for (const [slot, bot] of this.bots) {
        if (!bots.has(slot)) {
          const f = bot.sample(this.curState, slot);
          bots.set(slot, { dirs: f.dir, actions: f.action });
        }
      }
    }

    const bySlot = this.pendingInputs.get(t);
    if (bySlot === undefined) return false;
    for (let slot = 0; slot < this.numPlayers; slot++) {
      if (!bySlot.has(slot)) return false;
    }

    // Wire {dirs, actions} → sim {dir, action}, dense in slot order.
    const inputs: InputFrame[] = [];
    for (let slot = 0; slot < this.numPlayers; slot++) {
      const wire = bySlot.get(slot);
      inputs.push(
        wire === undefined
          ? NO_INPUT
          : { dir: wire.dirs, action: wire.actions },
      );
    }

    this.prevState = this.curState;
    this.curState = tick(this.curState, inputs);
    this.pendingInputs.delete(t);
    this.currentTick = t + 1;
    if (this.lastStall !== null && this.lastStall.t <= t) {
      this.lastStall = null; // the stalled tick has completed
    }

    const hash = this.curState.stateHash >>> 0;
    if (this.currentTick % HASH_REPORT_INTERVAL === 0) {
      this.client.sendHashReport(this.currentTick, hash);
      this.lastHashTick = this.currentTick;
      this.lastHash = hash;
    }
    this.onTick?.(this.currentTick, hash);
    return true;
  }

  // -- read access ---------------------------------------------------------------

  /** prev/next states + intra-tick alpha for interpolated rendering. */
  getRenderStates(): { prev: SimState; next: SimState; alpha: number } {
    return {
      prev: this.prevState,
      next: this.curState,
      alpha: Math.min(this.acc / TICK_MS, 1),
    };
  }

  getStatus(): LockstepStatus {
    return {
      currentTick: this.currentTick,
      mySlot: this.mySlot,
      numPlayers: this.numPlayers,
      stalled: this.blocked,
      stallWaiting: this.lastStall?.waiting ?? [],
      desynced: this.desynced,
      lastMismatch: this.lastMismatch,
      lastHashTick: this.lastHashTick,
      lastHash: this.lastHash,
      disconnectedSlots: [...this.disconnected],
    };
  }

  /** Next sim tick to produce (= ticks completed so far + t0). */
  get tickNow(): number {
    return this.currentTick;
  }

  get isDesynced(): boolean {
    return this.desynced;
  }

  /** Unsubscribe from all NetClient events (the socket is left open). */
  stop(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }
}
