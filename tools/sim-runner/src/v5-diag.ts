/**
 * v5-diag — FAILURE-TRAJECTORY diagnostic for the v5 bot.
 *
 * The probes (v5-probe / bt-rank) tell you WHETHER v5 wins; this tells you WHY it
 * LOSES, and — per the design brief — that the cause of a death is usually visible
 * ~10 seconds (600 ticks) earlier. It runs target vs an opponent under the SAME
 * CRN seeds the probes use, and for every game traces the TARGET's trajectory:
 * per tick it records the target's escape-branch count (dead-end detector), its
 * BFS distance to the foe, its safe free-space, and the development gap. When the
 * target dies it classifies the death (SEALED in a low-branch pocket vs caught in
 * the OPEN vs TRAPPED-then-shell-broken) and snapshots the trajectory at death,
 * 1 s before, and 10 s before — so a systematic early sign (already cornered /
 * already low-branch / already behind on dev ten seconds out) shows up in the
 * aggregate.
 *
 *   npm run v5-diag -- --target=v5:zoner [--opponent=v3:trapper] [--map=classic]
 *                      [--repeats=40]
 *
 * Pure analysis (no BT, no history). Deterministic CRN seeds (scenarioSeed).
 */
import { GamePhase } from '../../../shared/types';
import { FUSE_TICKS, MAP_COLS, SPARK_TICKS, SUDDEN_DEATH_START_TICK } from '../../../shared/constants';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { DIRECTION_ORDER } from '../../../client/src/sim/InputBuffer';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';
import { idx, inBounds } from '../../../client/src/sim/Map';
import { dirDX, dirDY, tileOf } from '../../../client/src/sim/Player';
import { openPassable, bfsFirstStep } from '../../../client/src/ai/common/grid';
import { buildDangerMap, type IntervalDanger } from '../../../client/src/ai/common/dangerMap';
import { MAPS, type MapKind, makeController } from './bench-utils';
import { scenarioSeed } from './matrix-runner';
import { arg, parseChallenger } from './bt-common';

const STEP_DANGER_HORIZON = SPARK_TICKS + 4;
const SURV_SAFE_HORIZON = FUSE_TICKS;
const WINDOW = 600; // 10 s @ 60 Hz — the "signs ten seconds earlier" window.
const SAMPLE_EVERY = 4; // compute the heavy danger features every N ticks (perf).
const RING_MAX = Math.ceil(WINDOW / SAMPLE_EVERY) + 2;
const FLOOD_CAP = 12;
const FREE_CAP = 24;

/** Escape-branch count — the SAME metric the v5 bot's anti-entrapment term uses. */
function escapeBranches(state: SimState, danger: IntervalDanger, rx: number, ry: number): number {
  const base = openPassable(state);
  const selfIdx = idx(rx, ry);
  let branches = 0;
  for (const d of DIRECTION_ORDER) {
    const nx = rx + dirDX(d);
    const ny = ry + dirDY(d);
    if (!inBounds(nx, ny) || !base(nx, ny)) continue;
    const nIdx = idx(nx, ny);
    const ne = danger.earliestLethal(nIdx);
    if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue;
    const seen = new Set<number>([selfIdx, nIdx]);
    const queue = [nIdx];
    let head = 0;
    let reached = false;
    let visited = 0;
    while (head < queue.length && visited < FLOOD_CAP) {
      const cur = queue[head]!;
      head += 1;
      visited += 1;
      const e = danger.earliestLethal(cur);
      if (e === undefined || e > SURV_SAFE_HORIZON) {
        reached = true;
        break;
      }
      const cx = cur % MAP_COLS;
      const cy = (cur - cx) / MAP_COLS;
      for (const dd of DIRECTION_ORDER) {
        const mx = cx + dirDX(dd);
        const my = cy + dirDY(dd);
        if (!inBounds(mx, my) || !base(mx, my)) continue;
        const mi = idx(mx, my);
        if (seen.has(mi)) continue;
        const me = danger.earliestLethal(mi);
        if (me !== undefined && me <= STEP_DANGER_HORIZON) continue;
        seen.add(mi);
        queue.push(mi);
      }
    }
    if (reached) branches += 1;
  }
  return branches;
}

/** Count of safe-dwell tiles reachable from (x,y) (a free-space proxy). */
function freeSpace(state: SimState, danger: IntervalDanger, x: number, y: number): number {
  const base = openPassable(state);
  const start = idx(x, y);
  const seen = new Set<number>([start]);
  const queue = [start];
  let head = 0;
  let count = 0;
  while (head < queue.length && count < FREE_CAP) {
    const cur = queue[head]!;
    head += 1;
    const e = danger.earliestLethal(cur);
    if (e === undefined || e > SURV_SAFE_HORIZON) count += 1;
    const cx = cur % MAP_COLS;
    const cy = (cur - cx) / MAP_COLS;
    for (const d of DIRECTION_ORDER) {
      const nx = cx + dirDX(d);
      const ny = cy + dirDY(d);
      if (!inBounds(nx, ny) || !base(nx, ny)) continue;
      const ni = idx(nx, ny);
      if (seen.has(ni)) continue;
      const ne = danger.earliestLethal(ni);
      if (ne !== undefined && ne <= STEP_DANGER_HORIZON) continue;
      seen.add(ni);
      queue.push(ni);
    }
  }
  return count;
}

interface Sample {
  tick: number;
  branches: number;
  foeMan: number;
  free: number;
  devGap: number; // (myFire+myCannon) - (foeFire+foeCannon)
  enemyBombsNear: number;
}

interface Loss {
  deathTick: number;
  cause: 'SEALED' | 'OPEN' | 'TRAPPED';
  atDeath: Sample;
  at1s: Sample | null;
  at10s: Sample | null;
}

function devSum(p: { fire: number; cannon: number }): number {
  return p.fire + p.cannon;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = parseChallenger(arg(argv, 'target', 'v5:zoner'));
  const opponent = parseChallenger(arg(argv, 'opponent', 'v3:trapper'));
  const repeats = Number(arg(argv, 'repeats', '40'));
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  console.log(
    `v5-diag: ${target.label} vs ${opponent.label}  ${repeats} repeats × 2 seatings × ${selMaps.length} map(s) [${selMaps.join(', ')}]`,
  );

  for (const map of selMaps) {
    const mapIndex = MAPS.indexOf(map);
    let wins = 0;
    let losses = 0;
    let draws = 0;
    const lossRecords: Loss[] = [];
    // For comparison: target's window-mean features sampled at game end in WINS.
    const winWindowBranches: number[] = [];
    const winWindowFoeMan: number[] = [];

    for (let r = 0; r < repeats; r++) {
      const seed = scenarioSeed(mapIndex, r);
      for (let seat = 0; seat < 2; seat++) {
        // seat 0: target in slot 0, opponent slot 1; seat 1: swapped.
        const targetSlot = seat === 0 ? 0 : 1;
        const oppSlot = seat === 0 ? 1 : 0;
        const agents = [target, opponent];
        const slotAgent = seat === 0 ? [0, 1] : [1, 0];

        let state: SimState = createInitialState(seed, makeFeelParams(), 2, {
          pvp: true,
          teams: [0, 1],
          map,
        });
        const ctrls = [0, 1].map((s) => {
          const a = agents[slotAgent[s]!]!;
          return makeController(a.version, a.archetypeKey, seed, s);
        });

        const ring: Sample[] = [];
        let targetDeathTick = -1;
        let wasTrappedRecently = false;

        while (state.phase === GamePhase.PLAYING && state.tick < 10800) {
          const frame: InputFrame[] = [0, 1].map((s) => ctrls[s]!.sample(state, s));
          // Sample the target's features BEFORE advancing (state the bot saw).
          const me = state.players[targetSlot]!;
          const foe = state.players[oppSlot]!;
          if (me.alive && !me.trapped) {
            const danger = buildDangerMap(state);
            const mx = tileOf(me.posX);
            const my = tileOf(me.posY);
            const fx = tileOf(foe.posX);
            const fy = tileOf(foe.posY);
            let foeMan = Math.abs(mx - fx) + Math.abs(my - fy);
            if (foe.alive && !foe.trapped) {
              const hit = bfsFirstStep(state, mx, my, (x, y) => x === fx && y === fy, openPassable(state));
              if (hit !== null) foeMan = hit.dist;
            }
            let enemyBombsNear = 0;
            for (const b of state.bombs) {
              if (b.ownerSlot === targetSlot) continue;
              if (Math.abs(b.tileX - mx) + Math.abs(b.tileY - my) <= b.fire + 2) enemyBombsNear += 1;
            }
            ring.push({
              tick: state.tick,
              branches: escapeBranches(state, danger, mx, my),
              foeMan,
              free: freeSpace(state, danger, mx, my),
              devGap: devSum(me) - devSum(foe),
              enemyBombsNear,
            });
            if (ring.length > WINDOW) ring.shift();
          }
          if (me.trapped) wasTrappedRecently = true;
          state = tick(state, frame);
          if (targetDeathTick === -1 && !state.players[targetSlot]!.alive) {
            targetDeathTick = state.tick;
            break;
          }
        }

        const targetAlive = state.players[targetSlot]!.alive;
        const oppAlive = state.players[oppSlot]!.alive;
        if (targetAlive && !oppAlive) {
          wins += 1;
          if (ring.length > 0) {
            const w = ring.slice(-Math.min(ring.length, WINDOW));
            winWindowBranches.push(mean(w.map((s) => s.branches)));
            winWindowFoeMan.push(mean(w.map((s) => s.foeMan)));
          }
        } else if (!targetAlive && oppAlive) {
          losses += 1;
          const atDeath = ring[ring.length - 1] ?? null;
          if (atDeath !== null) {
            const cause: Loss['cause'] = wasTrappedRecently
              ? 'TRAPPED'
              : atDeath.branches <= 1
                ? 'SEALED'
                : 'OPEN';
            lossRecords.push({
              deathTick: targetDeathTick,
              cause,
              atDeath,
              at1s: sampleAt(ring, targetDeathTick - 60),
              at10s: sampleAt(ring, targetDeathTick - WINDOW),
            });
          }
        } else if (!targetAlive && !oppAlive) {
          draws += 1;
        } else {
          // Both alive at cap: tiebreak — count by dev for a rough W/L (not a kill).
          const me = state.players[targetSlot]!;
          const foe = state.players[oppSlot]!;
          if (devSum(me) > devSum(foe)) wins += 1;
          else if (devSum(me) < devSum(foe)) losses += 1;
          else draws += 1;
        }
      }
    }

    report(map, wins, losses, draws, lossRecords, winWindowBranches, winWindowFoeMan);
  }
}

function sampleAt(ring: Sample[], atTick: number): Sample | null {
  let best: Sample | null = null;
  for (const s of ring) {
    if (s.tick <= atTick) best = s;
    else break;
  }
  return best;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function report(
  map: MapKind,
  wins: number,
  losses: number,
  draws: number,
  lossRecords: Loss[],
  winBranches: number[],
  winFoeMan: number[],
): void {
  const total = wins + losses + draws;
  const winPct = total === 0 ? 0 : (wins / total) * 100;
  console.log(`\n===== ${map} =====`);
  console.log(`games=${total}  target W/L/D = ${wins}/${losses}/${draws}  (winPct ${winPct.toFixed(1)}%)`);
  if (lossRecords.length === 0) {
    console.log('  no kill-losses recorded.');
  } else {
    const byCause: Record<string, number> = { SEALED: 0, OPEN: 0, TRAPPED: 0 };
    let preHunt = 0;
    let mid = 0;
    let shrink = 0;
    for (const l of lossRecords) {
      byCause[l.cause] = (byCause[l.cause] ?? 0) + 1;
      if (l.deathTick < 1200) preHunt += 1;
      else if (l.deathTick < SUDDEN_DEATH_START_TICK) mid += 1;
      else shrink += 1;
    }
    console.log(
      `  LOSS CAUSES: SEALED(dead-end) ${byCause.SEALED}  OPEN(timing) ${byCause.OPEN}  TRAPPED(shell) ${byCause.TRAPPED}`,
    );
    console.log(
      `  DEATH PHASE: pre-hunt(<20s) ${preHunt}  mid ${mid}  shrink(>=120s) ${shrink}`,
    );
    const atDeath = lossRecords.map((l) => l.atDeath);
    const at1s = lossRecords.map((l) => l.at1s).filter((s): s is Sample => s !== null);
    const at10s = lossRecords.map((l) => l.at10s).filter((s): s is Sample => s !== null);
    console.log('  TARGET trajectory before a LOSS (mean):');
    console.log(
      `    branches:  death ${mean(atDeath.map((s) => s.branches)).toFixed(2)}` +
        `   1s-before ${mean(at1s.map((s) => s.branches)).toFixed(2)}` +
        `   10s-before ${mean(at10s.map((s) => s.branches)).toFixed(2)}` +
        `   (WIN-game mean ${mean(winBranches).toFixed(2)})`,
    );
    console.log(
      `    foeDist:   death ${mean(atDeath.map((s) => s.foeMan)).toFixed(2)}` +
        `   1s-before ${mean(at1s.map((s) => s.foeMan)).toFixed(2)}` +
        `   10s-before ${mean(at10s.map((s) => s.foeMan)).toFixed(2)}` +
        `   (WIN-game mean ${mean(winFoeMan).toFixed(2)})`,
    );
    console.log(
      `    freeSpace: death ${mean(atDeath.map((s) => s.free)).toFixed(2)}` +
        `   1s-before ${mean(at1s.map((s) => s.free)).toFixed(2)}` +
        `   10s-before ${mean(at10s.map((s) => s.free)).toFixed(2)}`,
    );
    console.log(
      `    devGap:    death ${mean(atDeath.map((s) => s.devGap)).toFixed(2)}` +
        `   10s-before ${mean(at10s.map((s) => s.devGap)).toFixed(2)}`,
    );
    console.log(
      `    enemyBombsNear: death ${mean(atDeath.map((s) => s.enemyBombsNear)).toFixed(2)}` +
        `   1s-before ${mean(at1s.map((s) => s.enemyBombsNear)).toFixed(2)}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
