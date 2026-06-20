/**
 * SimState + the fixed-order tick function. This is the whole deterministic
 * core: same seed + same per-tick inputs ⇒ byte-identical state hashes on
 * every client.
 *
 * NOTE (deviation from the original plan): there is no `shells[]` array —
 * trap state is folded into PlayerState (see Shell.ts for the rationale).
 *
 * Tick system order (determinism contract — do not reorder):
 *  1. players: resolve buffered input & move (array order);
 *  2. bomb placement from action edges (array order);
 *  3. fuse decrement; detonations + chains → explosion cells, soft-brick
 *     destruction, item drops (PRNG draws — see Explosion.ts);
 *  4. explosion-cell hits: trap players (array order);
 *  5. item pickups (item-array order; first player in array order wins);
 *  6. shells: rescue, then timers → elimination;
 *  7. age & cull explosion cells;
 *  8. win check → maybe phase = OVER (always PvP: OVER once <=1 distinct team
 *     has an alive player);
 *  9. recompute stateHash, tick + 1.
 *
 * PRNG draw order across a whole tick: step 3 (drop rolls) only.
 * `createInitialState` draws: map generation ONLY (no per-entity spawn draws).
 */
import { MATCH_MAX_TICKS } from '../../../shared/constants';
import { GamePhase } from '../../../shared/types';
import {
  type FeelParams,
  cornerAssistMt,
  inputBufferTicks,
  moveSpeedMt,
} from '../config/FeelParams';
import { type BombState, bombPressedEdge, tryPlaceBomb } from './Bomb';
import {
  type ExplosionState,
  explosionAt,
  processDetonations,
} from './Explosion';
import { hashSimState } from './Hash';
import { type InputFrame, NO_INPUT } from './InputBuffer';
import { type ItemState, applyItem } from './Item';
import { type MapKind, SPAWN_CORNERS, type TileGrid, generateMap } from './Map';
import {
  type PlayerState,
  type SimParams,
  clonePlayer,
  createPlayer,
  stepPlayerMovement,
  tileOf,
} from './Player';
import { stepShells, trapPlayer } from './Shell';

export type { SimParams } from './Player';

export interface SimState {
  readonly tick: number;
  readonly phase: GamePhase;
  /** Mulberry32 state (uint32), threaded through every random draw. */
  readonly prng: number;
  /** Integer params derived once from FeelParams at match start. */
  readonly params: SimParams;
  readonly map: TileGrid;
  /**
   * Which map layout this match uses (classic / pirate …). A whole-match
   * constant fixed at createInitialState and carried forward unchanged every
   * tick — deliberately NOT hashed (exactly like `params.pvp` / `team`): the
   * grid TILES it selects are hashed via map generation, the selector itself is
   * a non-hashed match constant. Bots read it to pick a per-map decision profile.
   */
  readonly mapKind: MapKind;
  readonly players: readonly PlayerState[];
  readonly bombs: readonly BombState[];
  readonly explosions: readonly ExplosionState[];
  readonly items: readonly ItemState[];
  /** Canonical FNV-1a hash of everything above (see Hash.ts). */
  readonly stateHash: number;
}

/**
 * Create the initial match state.
 *
 * PRNG order: `generateMap` (see Map.ts) — and nothing else. There are no
 * per-entity spawn draws, so the whole initial PRNG state is fixed by the map.
 *
 * `opts` is optional. The `team`/`pvp`/`map` fields are deliberately NOT
 * hashed: they are whole-match constants fixed here once and (in net mode)
 * carried identically to every client by MatchStart. The map kind selects the
 * grid layout (whose tiles ARE hashed via map generation); the selector itself
 * is a match constant like teams. Team default = slot (teams[i] ?? i).
 */
export function createInitialState(
  seed: number,
  feelParams: FeelParams,
  numPlayers: number,
  opts?: {
    pvp?: boolean; // 預設 false（vestigial：行為一律 PvP，見 SimParams.pvp）
    teams?: readonly number[]; // 預設 teams[i] = i（隊伍即 slot）
    map?: MapKind; // 預設 'classic'（地圖布局種類，整場固定，非隨機）
  },
): SimState {
  // pvp is vestigial — kept on SimParams but never branches anything; the win
  // condition is always last-team-standing. Stored for compatibility only.
  const pvp = opts?.pvp ?? false;
  const teams = opts?.teams;

  const mapKind: MapKind = opts?.map ?? 'classic';
  const [map, prng] = generateMap(seed >>> 0, mapKind);

  const params: SimParams = Object.freeze({
    moveSpeedMt: moveSpeedMt(feelParams),
    cornerAssistMt: cornerAssistMt(feelParams),
    inputBufferTicks: inputBufferTicks(feelParams),
    // pvp is a whole-match constant; NOT hashed (see SimParams in Player.ts).
    pvp,
  });

  const n = Math.max(1, Math.min(numPlayers, SPAWN_CORNERS.length));
  const players: PlayerState[] = [];
  for (let i = 0; i < n; i++) {
    const corner = SPAWN_CORNERS[i];
    // team is a whole-match constant; NOT hashed (see PlayerState in Player.ts).
    // Default team = slot (each player on its own team unless opts.teams given).
    if (corner !== undefined) {
      players.push(createPlayer(i, corner[0], corner[1], teams?.[i] ?? i));
    }
  }

  const state: SimState = {
    tick: 0,
    phase: GamePhase.PLAYING,
    prng,
    params,
    map,
    mapKind,
    players,
    bombs: [],
    explosions: [],
    items: [],
    stateHash: 0,
  };
  return { ...state, stateHash: hashSimState(state) };
}

/**
 * Advance the simulation one tick. Pure: never mutates `state`; returns a
 * new SimState. `inputs[i]` is the InputFrame for players[i] (missing ⇒
 * NO_INPUT). System order documented at the top of this file.
 */
export function tick(state: SimState, inputs: readonly InputFrame[]): SimState {
  if (state.phase !== GamePhase.PLAYING) {
    // Frozen end state: only the tick counter advances.
    const frozen: SimState = { ...state, tick: state.tick + 1 };
    return { ...frozen, stateHash: hashSimState(frozen) };
  }

  let prng = state.prng;
  const grid = new Uint8Array(state.map);
  const players = state.players.map(clonePlayer);
  let bombs = state.bombs.map((b) => ({ ...b }));
  let explosions = state.explosions.map((c) => ({ ...c }));
  let items = state.items.map((it) => ({ ...it }));

  // (1) players: input resolution + movement.
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl === undefined) continue;
    stepPlayerMovement(grid, bombs, pl, inputs[i] ?? NO_INPUT, state.params);
  }

  // (2) bomb placement on action rising edge.
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    if (pl === undefined) continue;
    const input = inputs[i] ?? NO_INPUT;
    if (bombPressedEdge(pl.prevAction, input.action)) {
      const bomb = tryPlaceBomb(bombs, pl, tileOf(pl.posX), tileOf(pl.posY));
      if (bomb !== null) bombs.push(bomb);
    }
    pl.prevAction = input.action;
  }

  // (3) fuses + detonations (+ chains, brick destruction, item drops).
  for (const b of bombs) b.fuseTicks -= 1;
  const det = processDetonations(grid, bombs, prng);
  bombs = det.bombs;
  prng = det.prng;
  explosions.push(...det.cells);
  // A second (new) detonation destroys items already lying on the floor; the
  // items that just dropped THIS tick are not touched by this tick's own
  // explosion (the first bomb reveals the item, a later bomb burns it). Filter
  // existing items against this tick's new cells BEFORE pushing det.items.
  if (det.cells.length > 0 && items.length > 0) {
    items = items.filter((it) => !explosionAt(det.cells, it.tileX, it.tileY));
  }
  items.push(...det.items);
  for (const slot of det.detonatedOwners) {
    const owner = players.find((p) => p.slot === slot);
    if (owner !== undefined && owner.activeBombs > 0) owner.activeBombs -= 1;
  }

  // (4) explosion-cell hits: trap players.
  if (explosions.length > 0) {
    for (const pl of players) {
      if (
        pl.alive &&
        !pl.trapped &&
        explosionAt(explosions, tileOf(pl.posX), tileOf(pl.posY))
      ) {
        trapPlayer(pl);
      }
    }
  }

  // (5) item pickups.
  if (items.length > 0) {
    const remaining: ItemState[] = [];
    for (const it of items) {
      let taken = false;
      for (const pl of players) {
        if (
          pl.alive &&
          !pl.trapped &&
          tileOf(pl.posX) === it.tileX &&
          tileOf(pl.posY) === it.tileY
        ) {
          applyItem(pl, it.kind);
          taken = true;
          break;
        }
      }
      if (!taken) remaining.push(it);
    }
    items = remaining;
  }

  // (6) shells: rescue, then timers → elimination.
  stepShells(players);

  // (7) age & cull explosion cells.
  for (const c of explosions) c.ttlTicks -= 1;
  explosions = explosions.filter((c) => c.ttlTicks > 0);

  // (8) win check (always PvP / last-team-standing). The resulting phase IS
  // hashed. OVER once at most one distinct team still has an alive player
  // (a single survivor wins; everyone gone is also OVER), OR once the hard
  // match time cap is hit — the surviving teams are then resolved outside the
  // sim by most-survivors → item tiebreak → draw (see Outcome.ts).
  const nextTick = state.tick + 1;
  const aliveTeams = new Set<number>();
  for (const p of players) if (p.alive) aliveTeams.add(p.team);
  const phase =
    aliveTeams.size <= 1 || nextTick >= MATCH_MAX_TICKS
      ? GamePhase.OVER
      : GamePhase.PLAYING;

  // (9) assemble + hash.
  const next: SimState = {
    tick: nextTick,
    phase,
    prng,
    params: state.params,
    map: grid,
    // mapKind is a non-hashed whole-match constant — carry it forward verbatim.
    mapKind: state.mapKind,
    players,
    bombs,
    explosions,
    items,
    stateHash: 0,
  };
  return { ...next, stateHash: hashSimState(next) };
}
