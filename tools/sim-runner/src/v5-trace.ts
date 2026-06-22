/**
 * v5-trace — SPATIAL death replay. v5-diag tells you the aggregate STATS of a loss
 * (branch count, foe distance, enemy bombs near); this dumps the actual BOARD for
 * the last ~10 s of one representative LOSING game, so you can SEE how the seal
 * closes — which lane the foe's bombs cut, whether it is a pincer / vChain / the
 * shrink wall — not just the numbers.
 *
 *   npx tsx src/v5-trace.ts [--target=v5:zoner] [--opponent=v4:zoner]
 *                           [--map=classic] [--nth=0] [--repeats=40]
 *
 * Two-pass + CRN-deterministic: pass 1 finds the nth target kill-loss; pass 2
 * re-runs that exact (seed, seating) and prints frames at 10 s / 3 s / 1 s / death.
 *
 * Legend:  @ target   F foe   B target-bomb   X foe-bomb   ! lethal-soon tile
 *          # hard (incl. shrink wall)   o soft brick   · open / safe
 */
import { GamePhase, TileKind } from '../../../shared/types';
import {
  FUSE_TICKS,
  MAP_COLS,
  MAP_ROWS,
  SUDDEN_DEATH_START_TICK,
} from '../../../shared/constants';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type InputFrame } from '../../../client/src/sim/InputBuffer';
import { tick, createInitialState, type SimState } from '../../../client/src/sim/Sim';
import { idx } from '../../../client/src/sim/Map';
import { tileOf } from '../../../client/src/sim/Player';
import { buildDangerMap } from '../../../client/src/ai/common/dangerMap';
import { MAPS, type MapKind, makeController } from './bench-utils';
import { scenarioSeed } from './matrix-runner';
import { arg, parseChallenger } from './bt-common';

const WINDOW = 600; // 10 s @ 60 Hz.

/** Render one board state to ASCII rows (target/foe/bombs/danger/walls). */
function renderBoard(state: SimState, targetSlot: number, oppSlot: number): string[] {
  const danger = buildDangerMap(state);
  const me = state.players[targetSlot]!;
  const foe = state.players[oppSlot]!;
  const mx = tileOf(me.posX);
  const my = tileOf(me.posY);
  const fx = tileOf(foe.posX);
  const fy = tileOf(foe.posY);
  const bombChar = new Map<number, string>();
  for (const b of state.bombs) {
    bombChar.set(idx(b.tileX, b.tileY), b.ownerSlot === targetSlot ? 'B' : 'X');
  }
  const lines: string[] = [];
  for (let y = 0; y < MAP_ROWS; y++) {
    let row = '';
    for (let x = 0; x < MAP_COLS; x++) {
      const i = idx(x, y);
      let ch: string;
      if (me.alive && x === mx && y === my) ch = '@';
      else if (foe.alive && x === fx && y === fy) ch = 'F';
      else if (bombChar.has(i)) ch = bombChar.get(i)!;
      else if (state.map[i] === TileKind.HARD) ch = '#';
      else if (state.map[i] === TileKind.SOFT) ch = 'o';
      else {
        const e = danger.earliestLethal(i);
        ch = e !== undefined && e <= FUSE_TICKS ? '!' : '·';
      }
      row += ch;
    }
    lines.push(row);
  }
  return lines;
}

interface Snap {
  tick: number;
  lines: string[];
  foeBombs: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = parseChallenger(arg(argv, 'target', 'v5:zoner'));
  const opponent = parseChallenger(arg(argv, 'opponent', 'v4:zoner'));
  const map = arg(argv, 'map', 'classic') as MapKind;
  const nth = Number(arg(argv, 'nth', '0'));
  const repeats = Number(arg(argv, 'repeats', '40'));
  const mapIndex = MAPS.indexOf(map);
  if (mapIndex < 0) throw new Error(`unknown map ${map}`);

  // ---- PASS 1: find the nth target kill-loss (target dead, foe alive). --------
  let found: { r: number; seat: number; deathTick: number } | null = null;
  let lossIdx = -1;
  for (let r = 0; r < repeats && found === null; r++) {
    const seed = scenarioSeed(mapIndex, r);
    for (let seat = 0; seat < 2; seat++) {
      const targetSlot = seat === 0 ? 0 : 1;
      const oppSlot = seat === 0 ? 1 : 0;
      const slotAgent = seat === 0 ? [0, 1] : [1, 0];
      const agents = [target, opponent];
      let state: SimState = createInitialState(seed, makeFeelParams(), 2, {
        pvp: true,
        teams: [0, 1],
        map,
      });
      const ctrls = [0, 1].map((s) => {
        const a = agents[slotAgent[s]!]!;
        return makeController(a.version, a.archetypeKey, seed, s);
      });
      let deathTick = -1;
      while (state.phase === GamePhase.PLAYING && state.tick < 10800) {
        const frame: InputFrame[] = [0, 1].map((s) => ctrls[s]!.sample(state, s));
        state = tick(state, frame);
        if (!state.players[targetSlot]!.alive) {
          deathTick = state.tick;
          break;
        }
      }
      const targetAlive = state.players[targetSlot]!.alive;
      const oppAlive = state.players[oppSlot]!.alive;
      if (!targetAlive && oppAlive) {
        lossIdx += 1;
        if (lossIdx === nth) {
          found = { r, seat, deathTick };
          break;
        }
      }
    }
  }

  if (found === null) {
    console.log(
      `v5-trace: ${target.label} vs ${opponent.label} [${map}] — no kill-loss #${nth} found in ${repeats} repeats.`,
    );
    return;
  }

  // ---- PASS 2: re-run that exact game, capturing the last WINDOW ticks. -------
  const { r, seat, deathTick } = found;
  const seed = scenarioSeed(mapIndex, r);
  const targetSlot = seat === 0 ? 0 : 1;
  const oppSlot = seat === 0 ? 1 : 0;
  const slotAgent = seat === 0 ? [0, 1] : [1, 0];
  const agents = [target, opponent];
  let state: SimState = createInitialState(seed, makeFeelParams(), 2, {
    pvp: true,
    teams: [0, 1],
    map,
  });
  const ctrls = [0, 1].map((s) => {
    const a = agents[slotAgent[s]!]!;
    return makeController(a.version, a.archetypeKey, seed, s);
  });
  const ring: Snap[] = [];
  while (state.phase === GamePhase.PLAYING && state.tick < 10800) {
    const me = state.players[targetSlot]!;
    if (me.alive && !me.trapped) {
      let foeBombs = 0;
      for (const b of state.bombs) if (b.ownerSlot !== targetSlot) foeBombs += 1;
      ring.push({ tick: state.tick, lines: renderBoard(state, targetSlot, oppSlot), foeBombs });
      if (ring.length > WINDOW) ring.shift();
    }
    const frame: InputFrame[] = [0, 1].map((s) => ctrls[s]!.sample(state, s));
    state = tick(state, frame);
    if (!state.players[targetSlot]!.alive) break;
  }

  const phase =
    deathTick >= SUDDEN_DEATH_START_TICK ? 'SHRINK' : deathTick < 1200 ? 'pre-hunt' : 'mid';
  console.log(
    `v5-trace: ${target.label} vs ${opponent.label} [${map}]  loss #${nth}` +
      `  (repeat ${r}, seat ${seat})  deathTick=${deathTick} (${phase})\n` +
      `Legend: @ target  F foe  B target-bomb  X foe-bomb  ! lethal-soon  # hard  o soft  · open`,
  );

  const last = ring[ring.length - 1];
  if (last === undefined) {
    console.log('  (no alive frames captured)');
    return;
  }
  const pickAt = (ticksBefore: number): Snap | undefined => {
    const want = last.tick - ticksBefore;
    let best: Snap | undefined;
    for (const s of ring) {
      if (s.tick <= want) best = s;
      else break;
    }
    return best;
  };
  const frames: Array<{ label: string; snap: Snap | undefined }> = [
    { label: '10s before death', snap: pickAt(600) },
    { label: ' 3s before death', snap: pickAt(180) },
    { label: ' 1s before death', snap: pickAt(60) },
    { label: 'AT DEATH (last alive frame)', snap: last },
  ];
  for (const f of frames) {
    if (f.snap === undefined) continue;
    console.log(`\n──── ${f.label}  (tick ${f.snap.tick}, foe bombs live: ${f.snap.foeBombs}) ────`);
    for (const row of f.snap.lines) console.log('  ' + row);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
