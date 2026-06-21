/**
 * Seed the Bradley-Terry history with the v3 yardstick (one-time, re-run on a v3
 * change). Runs the v3 pool's internal 1v1 round-robin — every unordered pair,
 * both seatings, both maps, R repeats, under CRN — on the SHIPPING sim (sudden
 * death live), folds the results into per-map head-to-head tallies and writes
 * the committed bt-history/{classic,pirate}.json from scratch.
 *
 *   npm run bt-seed -- [--repeats=150] [--workers=8] [--include-noise]
 *
 * These files are the fixed reference field: bt-rank drops a new version's
 * strategy into them and the joint fit anchors the v3 pool mean to Elo 1500, so
 * v4 / v5 ratings stay comparable. Re-seeding REPLACES the v3 pairs (upsert),
 * so the file always reflects the current v3 code.
 */

import { BASE, MAPS, type MapKind } from './bench-utils';
import { buildGameList } from './matrix-runner';
import { agentIds, toTally } from './bt-history';
import { fitBradleyTerry } from './bradley-terry';
import {
  arg,
  idOf,
  mergeIntoHistories,
  runAndTally,
  saveHistory,
  v3PoolAgents,
} from './bt-common';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repeats = Number(arg(argv, 'repeats', '150'));
  const workers = Number(arg(argv, 'workers', '8'));
  const includeNoise = argv.includes('--include-noise');
  // --map re-seeds only the given map(s) (default: all). Only the selected maps'
  // history files are written, so the others are left intact (NOT overwritten
  // with empty data). CRN preserved (seeds key off the global map index).
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  const agents = v3PoolAgents(includeNoise);
  console.log(
    `Seeding BT history: v3 pool [${agents.map(idOf).join(', ')}]\n` +
      `  ${repeats} repeats × 2 seatings × ${selMaps.length} map(s) [${selMaps.join(', ')}], workers=${workers}`,
  );

  const games = buildGameList(agents, repeats, undefined, selMaps);
  console.log(`  scheduling ${games.length} duels…`);
  const t0 = Date.now();
  const byMap = await runAndTally(games, agents, workers);
  console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Write fresh histories (v3-only) for the SELECTED maps only, then show their
  // per-map ladder. Unselected maps' committed history files are left untouched.
  const histories = mergeIntoHistories(byMap, agents, { repeats, seedBase: BASE }, true);
  for (const map of selMaps) {
    const history = histories.get(map)!;
    saveHistory(history);
    const ids = agentIds(history);
    const r = fitBradleyTerry(toTally(history, ids));
    const ranked = ids
      .map((id, i) => ({ id, elo: r.elo[i]! }))
      .sort((a, b) => b.elo - a.elo);
    console.log(`\n${map} v3 yardstick (anchor: pool mean = 1500):`);
    for (const row of ranked) console.log(`  ${row.id.padEnd(14)} ${row.elo.toFixed(0)}`);
    console.log(`  wrote ${ids.length} agents, ${history.pairs.length} pairs`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
