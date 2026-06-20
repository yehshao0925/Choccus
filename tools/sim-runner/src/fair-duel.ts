/**
 * fair-duel — SYMMETRIC v3 vs v2 win rate under the GAME's real outcome rule
 * (resolveOutcome: last-team-alive → most survivors → item-development tiebreak →
 * draw). Unlike v3-bench (timeout = challenger loss, a deliberately unfair gate),
 * this is the rule a real PvP match uses, so it answers "who is actually the
 * stronger bot?". CRN-seeded, both seatings.
 *
 *   npx tsx src/fair-duel.ts [--v3=trapper --v2=aggressor --map=both --repeats=40]
 */
import { GamePhase } from '../../../shared/types';
import { AI_VERSIONS, type BotSpec, type IBotController } from '../../../client/src/ai/index';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { tick, createInitialState } from '../../../client/src/sim/Sim';
import { resolveOutcome } from '../../../client/src/sim/Outcome';
import { BASE, type MapKind } from './bench-utils';

const MAX_TICKS = 10800;

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
  const v3Arch = get('v3', 'trapper');
  const v2Arch = get('v2', 'aggressor');
  const repeats = Number(get('repeats', '40'));
  const mapArg = get('map', 'both');
  const maps: MapKind[] = mapArg === 'both' ? ['classic', 'pirate'] : [mapArg as MapKind];

  console.log(`fair-duel (GAME outcome rule: survivors → item tiebreak): v3-${v3Arch} vs v2-${v2Arch}, ${repeats}×2/map.`);
  for (let mi = 0; mi < maps.length; mi++) {
    const map = maps[mi]!;
    let v3 = 0, v2 = 0, draw = 0, n = 0, killEnds = 0, tickSum = 0;
    for (let r = 0; r < repeats; r++) {
      const seed = (BASE + mi * 1000 + r) >>> 0;
      for (const v3Slot of [0, 1]) {
        const v2Slot = v3Slot === 0 ? 1 : 0;
        let state = createInitialState(seed, makeFeelParams(), 2, { pvp: true, teams: [0, 1], map });
        const ctrl: IBotController[] = new Array(2);
        ctrl[v3Slot] = makeBot(3, v3Arch, seed, v3Slot);
        ctrl[v2Slot] = makeBot(2, v2Arch, seed, v2Slot);
        while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
          state = tick(state, [ctrl[0]!.sample(state, 0), ctrl[1]!.sample(state, 1)]);
        }
        if (state.players[v3Slot]!.alive !== state.players[v2Slot]!.alive) killEnds += 1;
        tickSum += state.tick;
        const o = resolveOutcome(state);
        const v3Team = state.players[v3Slot]!.team;
        const v2Team = state.players[v2Slot]!.team;
        if (o.winnerTeam === v3Team) v3 += 1;
        else if (o.winnerTeam === v2Team) v2 += 1;
        else draw += 1;
        n += 1;
      }
    }
    const pct = (x: number): string => `${((x / n) * 100).toFixed(1)}%`;
    console.log(
      `  ${map.padEnd(8)}: v3 ${pct(v3)}  v2 ${pct(v2)}  draw ${pct(draw)}  ` +
        `(${n} games; ${pct(killEnds)} ended in a real kill; avg end tick ${(tickSum / n).toFixed(0)})`,
    );
  }
}

main();
