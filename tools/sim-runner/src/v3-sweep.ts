/**
 * v3 classic farming-knob sweep. Uses BotController's `profileOverride` hook to
 * inject candidate CLASSIC MapProfiles into the v3 bot WITHOUT editing files, so
 * we can sweep several knob values in ONE run and pick the strongest. Each
 * candidate plays the classic 1v1 gate matchup (v3-<arch> vs v2-chaosv) over R
 * repeats × 2 seatings under CRN, reporting v3 win% (draws=0.5), itemScore lead,
 * and v3 death rate.
 *
 *   npm run v3-sweep [-- --arch=aggressor --repeats=30]
 *
 * Determinism: CRN seed per repeat; no Date/Math.random.
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
import { BotController } from '../../../client/src/ai/v3/BotController';
import { botSeed, tuningFor, parseDifficulty } from '../../../client/src/ai/v3/BotConfig';
import { resolveStrategy as resolveV3 } from '../../../client/src/ai/v3/Strategies';
import type { MapProfile } from '../../../client/src/ai/v3/MapProfile';
import { BASE } from './bench-utils';

const MAX_TICKS = 10800; // 3 min @ 60 Hz (= shared MATCH_MAX_TICKS)

function itemScore(p: PlayerState): number {
  return (
    (p.fire - PLAYER_START_FIRE) +
    (p.cannon - PLAYER_START_CANNON) +
    Math.trunc((p.speedBonusTenths - PLAYER_START_SPEED_BONUS) / 4)
  );
}

/** Base classic profile; candidates override individual knobs. */
function classicProfile(over: Partial<MapProfile>): MapProfile {
  return Object.freeze({
    map: 'classic',
    deferredBombDiscountPct: 100,
    stayPenalty: 0,
    survEnough: Number.MAX_SAFE_INTEGER,
    deadlockGrowthRelease: true,
    growUntilConnected: true,
    isolatedDevFloor: 100,
    isolatedSurvEnough: 8,
    cautionDist: 6,
    protectLead: true,
    multiBombFarm: true,
    ...over,
  }) as MapProfile;
}

function v3Tuning(arch: string): { tuning: ReturnType<typeof tuningFor>; name: string } {
  const r = resolveV3(arch);
  if (r) return { tuning: r.tuning as ReturnType<typeof tuningFor>, name: r.name };
  return { tuning: tuningFor(parseDifficulty('normal')), name: arch };
}

function v2Bot(arch: string, seed: number, slot: number): IBotController {
  const spec: BotSpec = { difficulty: 'normal', strategyRaw: arch };
  return AI_VERSIONS[2]!.createBot(seed, slot, spec);
}

interface Res { v3Win: number; v2Win: number; draw: number; v3Items: number; v2Items: number; v3Deaths: number; n: number; }

function runCandidate(arch: string, profile: MapProfile, repeats: number): Res {
  const { tuning } = v3Tuning(arch);
  const res: Res = { v3Win: 0, v2Win: 0, draw: 0, v3Items: 0, v2Items: 0, v3Deaths: 0, n: 0 };
  for (let r = 0; r < repeats; r++) {
    const seed = (BASE + r) >>> 0;
    for (const v3Slot of [0, 1]) {
      const v2Slot = v3Slot === 0 ? 1 : 0;
      let st = createInitialState(seed, makeFeelParams(), 2, { pvp: true, teams: [0, 1], map: 'classic' });
      const ctrl: IBotController[] = new Array(2);
      ctrl[v3Slot] = new BotController(botSeed(seed, v3Slot), tuning, v3Slot, profile);
      ctrl[v2Slot] = v2Bot('chaosv', seed, v2Slot);
      while (st.phase === GamePhase.PLAYING && st.tick < MAX_TICKS) {
        st = tick(st, [ctrl[0]!.sample(st, 0), ctrl[1]!.sample(st, 1)]);
      }
      const v3 = st.players[v3Slot]!; const v2 = st.players[v2Slot]!;
      const i3 = itemScore(v3); const i2 = itemScore(v2);
      res.n += 1; res.v3Items += i3; res.v2Items += i2;
      if (!v3.alive) res.v3Deaths += 1;
      // winner: clean kill else item tiebreak (items, fire, cannon)
      let v3won: boolean | null;
      if (st.phase === GamePhase.OVER && v3.alive && !v2.alive) v3won = true;
      else if (st.phase === GamePhase.OVER && v2.alive && !v3.alive) v3won = false;
      else if (i3 !== i2) v3won = i3 > i2;
      else if (v3.fire !== v2.fire) v3won = v3.fire > v2.fire;
      else if (v3.cannon !== v2.cannon) v3won = v3.cannon > v2.cannon;
      else v3won = null;
      if (v3won === true) res.v3Win += 1; else if (v3won === false) res.v2Win += 1; else res.draw += 1;
    }
  }
  return res;
}

function main(): number {
  const argv = process.argv.slice(2);
  const get = (k: string, d: string): string => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const arch = get('arch', 'aggressor');
  const repeats = Number(get('repeats', '30'));
  void parseDifficulty;

  // Candidate classic profiles to sweep (label → overrides).
  const candidates: Array<[string, Partial<MapProfile>]> = [
    ['baseline cD6 iso8', {}],
    ['iso6', { isolatedSurvEnough: 6 }],
    ['iso4', { isolatedSurvEnough: 4 }],
    ['iso2', { isolatedSurvEnough: 2 }],
    ['cD5 iso4', { cautionDist: 5, isolatedSurvEnough: 4 }],
    ['cD8 iso4', { cautionDist: 8, isolatedSurvEnough: 4 }],
    ['cD5 iso8', { cautionDist: 5 }],
    ['no multibomb (ref)', { multiBombFarm: false }],
  ];

  console.log(`v3-sweep: classic v3-${arch} vs v2-chaosv, repeats=${repeats} × 2 seatings = ${repeats * 2} games/candidate.`);
  console.log('candidate'.padEnd(26) + 'v3Win%   itemScore(v3/v2)  Δ      v3deaths%');
  for (const [label, over] of candidates) {
    const res = runCandidate(arch, classicProfile(over), repeats);
    const win = ((res.v3Win + 0.5 * res.draw) / res.n) * 100;
    const ai = res.v3Items / res.n; const bi = res.v2Items / res.n;
    console.log(
      label.padEnd(26) +
      `${win.toFixed(1)}%`.padStart(6) + '   ' +
      `${ai.toFixed(2)}/${bi.toFixed(2)}`.padStart(13) + '  ' +
      `${(ai - bi).toFixed(2)}`.padStart(5) + '   ' +
      `${((res.v3Deaths / res.n) * 100).toFixed(1)}%`.padStart(7),
    );
  }
  return 0;
}

process.exit(main());
