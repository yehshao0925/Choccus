/**
 * kill-probe — WHY doesn't v3 kill v2? Per-match instrumentation of the HUNT
 * dynamics the win-rate bench can't show: how close v3 gets to the foe, how
 * small it drives the foe's free space, how often it reaches a CHOKE (foe ≤1
 * safe tile) or a SEAL (0), the soft-brick count over time (does the map open up
 * and become un-trappable?), and the end reason. This tells us whether the
 * bottleneck is "never gets close", "gets close but can't compress", or "can
 * compress but can't finish".
 *
 *   npx tsx src/kill-probe.ts [--v3=aggressor --v2=aggressor --map=classic --repeats=12]
 */
import { GamePhase, TileKind } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { tileOf } from '../../../client/src/sim/Player';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { DIRECTION_ORDER } from '../../../client/src/sim/InputBuffer';
import { dirDX, dirDY } from '../../../client/src/sim/Player';
import { openPassable } from '../../../client/src/ai/common/grid';
import { buildDangerMap } from '../../../client/src/ai/common/dangerMap';
import { MAP_COLS, FUSE_TICKS } from '../../../shared/constants';
import { BASE, type MapKind } from './bench-utils';

const MAX_TICKS = 10800;
const FREE_CAP = 24;

/** Free safe-dwell tiles reachable from (fx,fy) — mirrors BotController.foeFreeSpace. */
function freeSpace(state: SimState, fx: number, fy: number): number {
  const base = openPassable(state);
  const danger = buildDangerMap(state);
  const start = idx(fx, fy);
  const seen = new Set<number>([start]);
  const q = [start];
  let head = 0;
  let count = 0;
  while (head < q.length && count < FREE_CAP) {
    const cur = q[head++]!;
    const cx = cur % MAP_COLS;
    const cy = (cur - cx) / MAP_COLS;
    const e = danger.earliestLethal(cur);
    if (e === undefined || e > FUSE_TICKS) count += 1;
    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny) || !base(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      q.push(ni);
    }
  }
  return count;
}

function softCount(state: SimState): number {
  let n = 0;
  for (const t of state.map) if (t === TileKind.SOFT) n += 1;
  return n;
}

function makeBot(version: number, arch: string, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: arch };
  return AI_VERSIONS[version]!.createBot(seed, slot, spec);
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const v3Arch = get('v3', 'hunter');
  const v2Arch = get('v2', 'aggressor');
  const map = get('map', 'classic') as MapKind;
  const repeats = Number(get('repeats', '12'));

  let kills = 0, deaths = 0, timeouts = 0;
  let sumMinFree = 0, sumChokeTicks = 0, sumSealTicks = 0;
  let sumMeanDist = 0, sumSoftEnd = 0, sumSoftStart = 0;
  let sumCloseTicks = 0; // ticks v3 within 3 BFS-ish (manhattan) of foe
  let n = 0;

  for (let r = 0; r < repeats; r++) {
    const seed = (BASE + r) >>> 0;
    for (const v3Slot of [0, 1]) {
      const v2Slot = v3Slot === 0 ? 1 : 0;
      let state = createInitialState(seed, makeFeelParams(), 2, { pvp: true, teams: [0, 1], map });
      const ctrl: IBotController[] = new Array(2);
      ctrl[v3Slot] = makeBot(3, v3Arch, seed, v3Slot);
      ctrl[v2Slot] = makeBot(2, v2Arch, seed, v2Slot);
      const softStart = softCount(state);
      let minFree = 99, chokeTicks = 0, sealTicks = 0, distSum = 0, distN = 0, closeTicks = 0;
      while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
        state = tick(state, [ctrl[0]!.sample(state, 0), ctrl[1]!.sample(state, 1)]);
        if (state.tick % 15 === 0) {
          const v3p = state.players[v3Slot]!;
          const v2p = state.players[v2Slot]!;
          if (v3p.alive && v2p.alive && !v2p.trapped) {
            const fx = tileOf(v2p.posX), fy = tileOf(v2p.posY);
            const f = freeSpace(state, fx, fy);
            if (f < minFree) minFree = f;
            if (f <= 1) chokeTicks += 1;
            if (f <= 0) sealTicks += 1;
            const dist = Math.abs(tileOf(v3p.posX) - fx) + Math.abs(tileOf(v3p.posY) - fy);
            distSum += dist; distN += 1;
            if (dist <= 3) closeTicks += 1;
          }
        }
      }
      n += 1;
      const v3p = state.players[v3Slot]!;
      const v2p = state.players[v2Slot]!;
      if (state.phase === GamePhase.OVER && v3p.alive && !v2p.alive) kills += 1;
      else if (state.phase === GamePhase.OVER && v2p.alive && !v3p.alive) deaths += 1;
      else timeouts += 1;
      sumMinFree += minFree === 99 ? FREE_CAP : minFree;
      sumChokeTicks += chokeTicks;
      sumSealTicks += sealTicks;
      sumMeanDist += distN > 0 ? distSum / distN : 0;
      sumCloseTicks += closeTicks;
      sumSoftEnd += softCount(state);
      sumSoftStart += softStart;
    }
  }

  const avg = (x: number): string => (x / n).toFixed(2);
  console.log(`kill-probe: v3-${v3Arch} vs v2-${v2Arch} on ${map}, ${n} games.`);
  console.log(`  kills(v3 win) = ${kills}/${n} (${((kills / n) * 100).toFixed(1)}%)  deaths = ${deaths}  timeouts = ${timeouts}`);
  console.log(`  avg min foe free-space reached : ${avg(sumMinFree)}  (lower = bot compresses foe more; CAP=${FREE_CAP})`);
  console.log(`  avg CHOKE samples (foe ≤1 free): ${avg(sumChokeTicks)} per game  (sampled every 15 ticks)`);
  console.log(`  avg SEAL  samples (foe = 0 free): ${avg(sumSealTicks)} per game`);
  console.log(`  avg mean v3→foe manhattan dist  : ${avg(sumMeanDist)}  (lower = bot camps closer)`);
  console.log(`  avg ticks v3 within 3 of foe    : ${avg(sumCloseTicks)} samples/game`);
  console.log(`  avg soft bricks start→end       : ${avg(sumSoftStart)} → ${avg(sumSoftEnd)}  (map opening up?)`);
}

main();
