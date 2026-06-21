/**
 * Place a new strategy on the v3 Bradley-Terry yardstick.
 *
 * Runs the target (e.g. v4:hunter) vs the v3 pool — both seatings × repeats ×
 * both maps, CRN — on the shipping sim, folds the duels into the persistent
 * history (upsert-by-pair), then re-fits BT jointly over the WHOLE accumulated
 * history (old v3 round-robin + every version placed so far) and prints, per
 * map, the global Elo ladder with the target slotted in. Because the fit anchors
 * the v3 pool mean to 1500, the target's Elo is directly comparable to any other
 * version placed the same way — even versions it never played, via shared v3
 * opponents (sparse joint estimation).
 *
 *   npm run bt-rank -- --target=v4:hunter [--repeats=150] [--workers=8]
 *                      [--opponents=hunter,zoner] [--include-noise] [--no-write]
 *
 * Win encoding (post sudden-death): a win = killed the opponent (bomb OR arena-
 * shrink crush) within the cap; same-tick mutual KO = 0.5. Farming to the cap is
 * mechanically impossible, so there is no timeout-loss special case.
 */

import { BASE, MAPS, type Agent, type MapKind, makeAgent } from './bench-utils';
import { type History, agentIds, toTally } from './bt-history';
import {
  connectedComponents,
  fitBradleyTerry,
  predictedWinProb,
} from './bradley-terry';
import {
  type PairTally,
  V3_NOISE,
  V3_POOL,
  arg,
  buildChallengerGames,
  idOf,
  mergeIntoHistories,
  parseChallenger,
  runAndTally,
  saveHistory,
} from './bt-common';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetSpec = arg(argv, 'target', '');
  if (!targetSpec) throw new Error('--target=v<N>:<archetype> is required (e.g. v4:hunter)');
  const repeats = Number(arg(argv, 'repeats', '150'));
  const workers = Number(arg(argv, 'workers', '8'));
  const includeNoise = argv.includes('--include-noise');
  const write = !argv.includes('--no-write');

  const challenger = parseChallenger(targetSpec);
  const oppArches = arg(argv, 'opponents', '')
    ? arg(argv, 'opponents', '').split(',').map((s) => s.trim().toLowerCase())
    : includeNoise
      ? [...V3_POOL, V3_NOISE]
      : [...V3_POOL];

  // Pool = [challenger, ...v3 opponents]; challenger is index 0.
  const agents = [challenger, ...oppArches.map((a) => makeAgent(3, a))];
  const opponents = oppArches.map((_, i) => i + 1);

  console.log(
    `Placing ${idOf(challenger)} vs v3 pool [${oppArches.join(', ')}]\n` +
      `  ${repeats} repeats × 2 seatings × ${MAPS.length} maps, workers=${workers}` +
      (write ? '' : '  (--no-write: not persisting)'),
  );

  const games = buildChallengerGames(0, opponents, repeats);
  const t0 = Date.now();
  const byMap = await runAndTally(games, agents, workers);
  console.log(`  ran ${games.length} duels in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Upsert into each map's history; persist unless --no-write.
  const histories = mergeIntoHistories(byMap, agents, { repeats, seedBase: BASE });
  for (const map of MAPS) {
    if (write) saveHistory(histories.get(map)!);
    reportMap(map, histories.get(map)!, idOf(challenger), byMap.get(map)!, agents, opponents);
  }
  if (!write) console.log('\n(--no-write) histories were NOT saved.');
}

/** Print one map's full ladder + the target's per-opponent observed-vs-predicted. */
function reportMap(
  map: MapKind,
  history: History,
  targetId: string,
  tallies: Map<string, PairTally>,
  agents: Agent[],
  opponents: number[],
): void {
  const ids = agentIds(history);
  const games = toTally(history, ids).games;

  // Connectivity: BT only places agents on one scale within a component.
  const comps = connectedComponents(games);
  if (comps.length > 1) {
    const groups = comps.map((c) => c.map((i) => ids[i]).join('+')).join('  |  ');
    console.log(`\n${map}: ⚠ comparison graph is DISCONNECTED — ratings not comparable.`);
    console.log(`  components: ${groups}`);
    console.log('  → have the target play opponents bridging these groups, then re-run.');
    return;
  }

  // Anchor the fit to the v3 pool (the reference set), so 1500 = average v3.
  const anchorIndices = ids
    .map((id, i) => (V3_POOL.includes(stripVer(id)) && id.startsWith('v3:') ? i : -1))
    .filter((i) => i >= 0);
  const r = fitBradleyTerry(toTally(history, ids), { anchorIndices });

  const ranked = ids
    .map((id, i) => ({ id, elo: r.elo[i]!, idx: i }))
    .sort((a, b) => b.elo - a.elo || a.id.localeCompare(b.id));

  console.log(`\n${map} Bradley-Terry ladder (anchor: v3 pool mean = 1500):`);
  for (let rank = 0; rank < ranked.length; rank++) {
    const row = ranked[rank]!;
    const mark = row.id === targetId ? '  ← target' : '';
    console.log(`  ${String(rank + 1).padStart(2)}  ${row.id.padEnd(14)} ${row.elo.toFixed(0)}${mark}`);
  }

  // Per-opponent: observed challenger win% vs the BT-predicted win%. A large
  // negative residual flags a specific counter (intransitivity vs the RPS pool).
  const betaOf = (id: string): number => r.beta[ids.indexOf(id)]!;
  const targetBeta = betaOf(targetId);
  console.log(`  ${targetId} per-opponent (observed vs BT-predicted win%, Δ):`);
  for (const oppIdx of opponents) {
    const oppId = idOf(agents[oppIdx]!);
    // Pool pair was [0=challenger, oppIdx]; lo=0 so winsLo = challenger wins.
    const t = tallies.get(`0|${oppIdx}`);
    if (!t) continue;
    const total = t.winsLo + t.winsHi;
    const obs = total === 0 ? 0 : t.winsLo / total;
    const pred = predictedWinProb(targetBeta, betaOf(oppId));
    const delta = (obs - pred) * 100;
    const flag = delta <= -10 ? '  ← counter' : delta >= 10 ? '  ← favourable' : '';
    console.log(
      `    vs ${oppId.padEnd(12)} ${(obs * 100).toFixed(0).padStart(3)}%  (pred ${(pred * 100).toFixed(0).padStart(3)}%)  ${delta >= 0 ? '+' : ''}${delta.toFixed(0)}${flag}`,
    );
  }
}

/** "v3:hunter" → "hunter" (archetype without the version prefix). */
function stripVer(id: string): string {
  const i = id.indexOf(':');
  return i < 0 ? id : id.slice(i + 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
