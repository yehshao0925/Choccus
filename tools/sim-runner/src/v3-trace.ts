/**
 * v3-trace — where does the bot's TIME go while isolated? Runs one v3 bot in a
 * real 1v1 vs a v2 bot and, for the v3 side, histograms its emitted action each
 * tick (BOMB / STAY / MOVE / NO_INPUT), counts bombs actually placed, tracks the
 * whole map's soft-brick count over time, and samples the v3 bot's fire/cannon +
 * open-path foe distance (isolation signal) at checkpoints. This reveals whether
 * the bot is idling, wandering, escaping, or productively bombing — the thing the
 * win-rate/diag benches can't show.
 *
 *   npm run v3-trace [-- --v3=tempering --v2=chaosv --map=classic --seed=0]
 */
import { ActionFlags, Direction, GamePhase, TileKind } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { isOpen, tileOf } from '../../../client/src/sim/Player';
import { DIRECTION_ORDER } from '../../../client/src/sim/InputBuffer';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';
import { BASE, type MapKind } from './bench-utils';

const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)

function softCount(map: Uint8Array): number {
  let s = 0;
  for (const t of map) if (t === TileKind.SOFT) s += 1;
  return s;
}

/** Open-path BFS hop distance from (x,y) to the other player; 40 = no open path. */
function openFoeDist(state: SimState, fromSlot: number): number {
  const me = state.players[fromSlot]!;
  const foe = state.players.find((p) => p.slot !== fromSlot);
  if (foe === undefined || !foe.alive || foe.trapped) return 40;
  const fx = tileOf(foe.posX); const fy = tileOf(foe.posY);
  const sx = tileOf(me.posX); const sy = tileOf(me.posY);
  const start = idx(sx, sy);
  const dist = new Map<number, number>([[start, 0]]);
  const q = [start]; let c = 0;
  while (c < q.length) {
    const cur = q[c++]!; const cx = cur % 15; const cy = (cur - cx) / 15;
    if (cx === fx && cy === fy) return Math.min(40, dist.get(cur)!);
    for (const d of DIRECTION_ORDER) {
      const nx = cx + (d === Direction.LEFT ? -1 : d === Direction.RIGHT ? 1 : 0);
      const ny = cy + (d === Direction.UP ? -1 : d === Direction.DOWN ? 1 : 0);
      if (!inBounds(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (dist.has(ni)) continue;
      if (!isOpen(state.map, state.bombs, nx, ny)) continue;
      dist.set(ni, dist.get(cur)! + 1); q.push(ni);
    }
  }
  return 40;
}

function main(): number {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const v3Arch = get('v3', 'tempering');
  const v2Arch = get('v2', 'chaosv');
  const map = get('map', 'classic') as MapKind;
  const seed = (BASE + Number(get('seed', '0'))) >>> 0;

  let state = createInitialState(seed, makeFeelParams(), 2, { pvp: true, teams: [0, 1], map });
  const spec3: BotSpec = { difficulty: 'normal', strategyRaw: v3Arch };
  const spec2: BotSpec = { difficulty: 'normal', strategyRaw: v2Arch };
  const c3: IBotController = AI_VERSIONS[3]!.createBot(seed, 0, spec3);
  const c2: IBotController = AI_VERSIONS[2]!.createBot(seed, 1, spec2);

  const startSoft = softCount(state.map as Uint8Array);
  let bomb = 0, stay = 0, move = 0, noInput = 0;
  let bombsPlaced = 0;
  let isolatedTicks = 0;
  const checkpoints = [1800, 3600, 5400, 7200, 9000, 10800];
  let cpI = 0;

  console.log(`v3-trace: v3-${v3Arch}(slot0) vs v2-${v2Arch}(slot1), map=${map}, seed=${seed}.`);
  console.log(`map start soft bricks = ${startSoft}`);
  console.log('tick  | v3 fire/cannon/spd | foeDist | softLeft | v3 bombsPlaced');

  while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
    const f3 = c3.sample(state, 0);
    const f2 = c2.sample(state, 1);
    // classify v3's emitted action
    if (f3.action === ActionFlags.BOMB) bomb += 1;
    else if (f3.dir === Direction.NONE) {
      // distinguish STAY (alive & acting) from NO_INPUT (dead/trapped)
      const me = state.players[0]!;
      if (!me.alive || me.trapped) noInput += 1; else stay += 1;
    } else move += 1;

    const beforeBombs = state.bombs.length;
    const myBefore = state.bombs.filter((b) => b.ownerSlot === 0).length;
    state = tick(state, [f3, f2]);
    const myAfter = state.bombs.filter((b) => b.ownerSlot === 0).length;
    if (myAfter > myBefore) bombsPlaced += 1;
    void beforeBombs;

    if (openFoeDist(state, 0) >= 40) isolatedTicks += 1;

    if (cpI < checkpoints.length && state.tick >= checkpoints[cpI]!) {
      const me = state.players[0]!;
      console.log(
        `${String(state.tick).padStart(5)} | ` +
        `${me.fire}/${me.cannon}/${me.speedBonusTenths}`.padEnd(18) + ' | ' +
        `${String(openFoeDist(state, 0)).padStart(7)} | ` +
        `${String(softCount(state.map as Uint8Array)).padStart(8)} | ` +
        `${bombsPlaced}`,
      );
      cpI += 1;
    }
  }

  const endSoft = softCount(state.map as Uint8Array);
  const total = bomb + stay + move + noInput;
  const me = state.players[0]!; const foe = state.players[1]!;
  console.log('');
  console.log(`END tick=${state.tick}  v3 fire/cannon/spd=${me.fire}/${me.cannon}/${me.speedBonusTenths}  v2=${foe.fire}/${foe.cannon}/${foe.speedBonusTenths}`);
  console.log(`bricks cleared (whole map, both bots) = ${startSoft - endSoft} of ${startSoft}`);
  console.log(`v3 bombs actually placed = ${bombsPlaced}`);
  console.log(`v3 isolated (no open path to foe) for ${isolatedTicks}/${state.tick} ticks (${((isolatedTicks / state.tick) * 100).toFixed(0)}%)`);
  console.log('v3 emitted-action histogram:');
  console.log(`  BOMB    : ${bomb} (${((bomb / total) * 100).toFixed(1)}%)`);
  console.log(`  MOVE    : ${move} (${((move / total) * 100).toFixed(1)}%)`);
  console.log(`  STAY    : ${stay} (${((stay / total) * 100).toFixed(1)}%)`);
  console.log(`  NO_INPUT: ${noInput} (${((noInput / total) * 100).toFixed(1)}%)`);
  return 0;
}

process.exit(main());
