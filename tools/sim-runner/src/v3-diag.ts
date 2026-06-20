/**
 * v3 diagnostic — WHY does (or doesn't) v3 beat v2? Runs a single
 * (v3 archetype vs v2 archetype) 1v1 on a map over R repeats × 2 seatings and
 * reports the MECHANISM: average end-of-match fire/cannon/speed/itemScore per
 * side, how often v3 ends with strictly more items, the kill rate (clean
 * eliminations vs tick-cap tiebreaks), and avg end tick. This exposes whether the
 * connectivity doctrine actually produces a material development lead — the lever
 * the win-rate bench can't show.
 *
 *   npm run v3-diag [-- --v3=tempering --v2=chaosv --map=classic --repeats=40]
 *
 * Determinism: CRN seed per repeat, shared across seatings. No Date/Math.random.
 */
import { GamePhase } from '../../../shared/types';
import {
  PLAYER_START_CANNON,
  PLAYER_START_FIRE,
  PLAYER_START_SPEED_BONUS,
} from '../../../shared/constants';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { type PlayerState } from '../../../client/src/sim/Player';
import { tick, createInitialState } from '../../../client/src/sim/Sim';
import { BASE, type MapKind } from './bench-utils';

const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)

function itemScore(p: PlayerState): number {
  return (
    (p.fire - PLAYER_START_FIRE) +
    (p.cannon - PLAYER_START_CANNON) +
    Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4)
  );
}

function makeBot(version: number, arch: string, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: arch };
  return AI_VERSIONS[version]!.createBot(seed, slot, spec);
}

interface End {
  v3: PlayerState;
  v2: PlayerState;
  endTick: number;
  cleanKill: boolean; // someone actually died (phase OVER, not tiebreak)
}

/** Run one duel; v3Slot/v2Slot in {0,1}. Returns final player states by side. */
function runOne(seed: number, map: MapKind, v3Arch: string, v2Arch: string, v3Slot: number): End {
  const v2Slot = v3Slot === 0 ? 1 : 0;
  let state = createInitialState(seed, makeFeelParams(), 2, { pvp: true, teams: [0, 1], map });
  const ctrl: IBotController[] = new Array(2);
  ctrl[v3Slot] = makeBot(3, v3Arch, seed, v3Slot);
  ctrl[v2Slot] = makeBot(2, v2Arch, seed, v2Slot);
  while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
    state = tick(state, [ctrl[0]!.sample(state, 0), ctrl[1]!.sample(state, 1)]);
  }
  return {
    v3: state.players[v3Slot]!,
    v2: state.players[v2Slot]!,
    endTick: state.tick,
    cleanKill: state.phase === GamePhase.OVER,
  };
}

interface Acc {
  n: number;
  v3Items: number; v2Items: number;
  v3Fire: number; v2Fire: number;
  v3Cannon: number; v2Cannon: number;
  v3MoreItems: number; v2MoreItems: number; equalItems: number;
  v3Win: number; v2Win: number; draw: number;
  cleanKills: number;
  v3KilledV2: number; v2KilledV3: number;
  endTickSum: number;
}

function main(): number {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => {
    const a = argv.find((x) => x.startsWith(`--${k}=`));
    return a ? a.slice(k.length + 3) : d;
  };
  const v3Arch = get('v3', 'hunter');
  const v2Arch = get('v2', 'chaosv');
  const repeats = Number(get('repeats', '40'));
  const mapArg = get('map', 'both');
  const maps: MapKind[] = mapArg === 'both' ? ['classic', 'pirate'] : [mapArg as MapKind];

  console.log(`v3-diag: v3-${v3Arch} vs v2-${v2Arch}, repeats=${repeats} × 2 seatings/map.`);

  for (let mi = 0; mi < maps.length; mi++) {
    const map = maps[mi]!;
    const acc: Acc = {
      n: 0, v3Items: 0, v2Items: 0, v3Fire: 0, v2Fire: 0, v3Cannon: 0, v2Cannon: 0,
      v3MoreItems: 0, v2MoreItems: 0, equalItems: 0, v3Win: 0, v2Win: 0, draw: 0,
      cleanKills: 0, v3KilledV2: 0, v2KilledV3: 0, endTickSum: 0,
    };
    for (let r = 0; r < repeats; r++) {
      const seed = (BASE + mi * 1000 + r) >>> 0;
      for (const v3Slot of [0, 1]) {
        const e = runOne(seed, map, v3Arch, v2Arch, v3Slot);
        acc.n += 1;
        const i3 = itemScore(e.v3); const i2 = itemScore(e.v2);
        acc.v3Items += i3; acc.v2Items += i2;
        acc.v3Fire += e.v3.fire; acc.v2Fire += e.v2.fire;
        acc.v3Cannon += e.v3.cannon; acc.v2Cannon += e.v2.cannon;
        if (i3 > i2) acc.v3MoreItems += 1; else if (i2 > i3) acc.v2MoreItems += 1; else acc.equalItems += 1;
        acc.endTickSum += e.endTick;
        if (e.cleanKill) {
          acc.cleanKills += 1;
          if (e.v3.alive && !e.v2.alive) { acc.v3Win += 1; acc.v3KilledV2 += 1; }
          else if (e.v2.alive && !e.v3.alive) { acc.v2Win += 1; acc.v2KilledV3 += 1; }
          else acc.draw += 1; // both died same tick (rare)
        } else {
          // tick cap: item tiebreak
          if (i3 > i2 || (i3 === i2 && e.v3.fire > e.v2.fire)) acc.v3Win += 1;
          else if (i2 > i3 || (i3 === i2 && e.v2.fire > e.v3.fire)) acc.v2Win += 1;
          else acc.draw += 1;
        }
      }
    }
    const n = acc.n;
    const pct = (x: number): string => `${((x / n) * 100).toFixed(1)}%`;
    const avg = (x: number): string => (x / n).toFixed(2);
    console.log('');
    console.log(`--- MAP: ${map} (${n} games) ---`);
    console.log(`  avg itemScore : v3=${avg(acc.v3Items)}  v2=${avg(acc.v2Items)}  (Δ=${((acc.v3Items - acc.v2Items) / n).toFixed(2)})`);
    console.log(`  avg fire      : v3=${avg(acc.v3Fire)}  v2=${avg(acc.v2Fire)}`);
    console.log(`  avg cannon    : v3=${avg(acc.v3Cannon)}  v2=${avg(acc.v2Cannon)}`);
    console.log(`  more items    : v3=${pct(acc.v3MoreItems)}  v2=${pct(acc.v2MoreItems)}  equal=${pct(acc.equalItems)}`);
    console.log(`  win rate      : v3=${pct(acc.v3Win)}  v2=${pct(acc.v2Win)}  draw=${pct(acc.draw)}`);
    console.log(`  clean kills   : ${pct(acc.cleanKills)} of games  (v3 killed v2: ${acc.v3KilledV2}, v2 killed v3: ${acc.v2KilledV3})`);
    console.log(`  avg end tick  : ${avg(acc.endTickSum)} (cap ${MAX_TICKS})`);
  }
  return 0;
}

process.exit(main());
