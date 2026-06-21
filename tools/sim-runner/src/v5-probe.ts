/**
 * v5-probe — fast, throwaway A/B probe for a BRAND-NEW strategy against the
 * FRONTIER blockers, NOT the whole v3 yardstick.
 *
 * Why this exists (vs bt-rank): bt-rank ranks a challenger against the six FROZEN
 * v3 archetypes and infers its standing vs every other PLACED version (e.g.
 * v4:zoner) only TRANSITIVELY, through shared v3 opponents. For a genuinely new
 * strategy family that transitive edge is the least trustworthy number on the
 * board — the roster is deliberately non-transitive (RPS), so a novel family can
 * beat/lose to v4 in ways the v3-pool fit can't predict. When iterating a v5
 * design you want the ONE thing the ladder can't give cheaply: the DIRECT,
 * same-seed (CRN) head-to-head vs the bots that actually cap the frontier —
 *   - v4:zoner   = the live champion (the real SHIP GATE: beat it or it is not an
 *                  upgrade, no matter how high the v3-pool Elo looks)
 *   - v3:trapper = the strongest blocking mirror (the historic v4 ceiling)
 *
 * It runs target vs each (versioned) opponent over repeats × 2 seatings × map(s)
 * under the SAME CRN seeds bt-rank/v3-bench use, and prints per-opponent observed
 * win% (challenger credit, draws = 0.5). It NEVER fits BT and NEVER writes
 * history — it is purely a development probe: run it before and after a change and
 * diff the win%. CRN holds the map layout and each slot's bot RNG fixed across
 * runs, so a win% shift isolates the policy change (paired A/B, low variance).
 *
 *   npm run v5-probe -- --target=v5:<arch>
 *     [--opponents=v4:zoner,v3:trapper]  versioned opponents (default = frontier)
 *     [--map=classic|pirate]             default both
 *     [--repeats=40] [--workers=8] [--label=str]
 *
 * Win encoding matches bt-rank (post sudden-death): a win = killed the opponent
 * (bomb OR arena-shrink crush) within the cap; same-tick mutual KO = 0.5; farming
 * to the cap is mechanically impossible, so there is no timeout special case.
 *
 * Determinism: every seed is the pure CRN scenarioSeed(mapIndex, repeat); no
 * Math.random. (Date.now is wall-clock timing only, as in bt-rank.)
 */

import { MAPS, type Agent, type MapKind } from './bench-utils';
import {
  type PairTally,
  arg,
  buildChallengerGames,
  idOf,
  parseChallenger,
  runAndTally,
} from './bt-common';

/** Default opponents: the two bots that cap the frontier (live champion + mirror). */
const FRONTIER = 'v4:zoner,v3:trapper';

/** A per-opponent observed result on one map. */
interface Cell {
  oppId: string;
  oppVersion: number;
  winPct: number;
  total: number;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetSpec = arg(argv, 'target', '');
  if (!targetSpec) {
    throw new Error('--target=v<N>:<archetype> is required (e.g. v5:disruptor)');
  }
  const repeats = Number(arg(argv, 'repeats', '40'));
  const workers = Number(arg(argv, 'workers', '8'));
  const label = arg(argv, 'label', '');
  // --map filters which maps to actually run (default: both). CRN is preserved:
  // scenarioSeed keys off the GLOBAL map index, never the filtered list.
  const mapArg = arg(argv, 'map', '');
  const selMaps = mapArg
    ? (mapArg.split(',').map((s) => s.trim()) as MapKind[]).filter((m) => MAPS.includes(m))
    : MAPS;

  const challenger = parseChallenger(targetSpec);
  const oppAgents = arg(argv, 'opponents', FRONTIER)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseChallenger);
  if (oppAgents.length === 0) throw new Error('--opponents resolved to an empty list');

  // Pool = [challenger, ...opponents]; challenger is index 0 (the canonical "lo").
  const agents = [challenger, ...oppAgents];
  const opponents = oppAgents.map((_, i) => i + 1);
  // The de-facto ship gate = the highest-version opponent (the live frontier).
  const gateVersion = Math.max(...oppAgents.map((a) => a.version));

  console.log(
    `v5-probe: ${idOf(challenger)} vs [${oppAgents.map(idOf).join(', ')}]` +
      (label ? `  «${label}»` : '') +
      `\n  ${repeats} repeats × 2 seatings × ${selMaps.length} map(s) [${selMaps.join(', ')}], ` +
      `workers=${workers}  (probe: no BT fit, no history write)`,
  );

  const games = buildChallengerGames(0, opponents, repeats, selMaps);
  const t0 = Date.now();
  const byMap = await runAndTally(games, agents, workers);
  console.log(`  ran ${games.length} duels in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const cellsByMap = new Map<MapKind, Cell[]>();
  for (const map of selMaps) {
    cellsByMap.set(map, reportMap(map, byMap.get(map)!, agents, opponents, gateVersion, label));
  }

  shipGateVerdict(selMaps, cellsByMap, idOf(challenger), gateVersion);
}

/** Print one map's per-opponent win% block + a one-line diffable SUMMARY. */
function reportMap(
  map: MapKind,
  tallies: Map<string, PairTally>,
  agents: Agent[],
  opponents: number[],
  gateVersion: number,
  label: string,
): Cell[] {
  const cells: Cell[] = [];
  console.log(`\n${map}  (challenger win%, draws=0.5):`);
  for (const oppIdx of opponents) {
    const oppAgent = agents[oppIdx]!;
    const oppId = idOf(oppAgent);
    // Pool pair was [0=challenger, oppIdx]; lo=0 so winsLo = challenger credit.
    const t = tallies.get(`0|${oppIdx}`);
    const total = t ? t.winsLo + t.winsHi : 0;
    const winPct = total === 0 ? 0 : (t!.winsLo / total) * 100;
    const dev = winPct - 50;
    // ±2 pt dead-band so single-run noise doesn't masquerade as a verdict.
    const flag = dev <= -2 ? '  ← behind' : dev >= 2 ? '  ← ahead' : '  ~ even';
    // Only the live champion (highest version, and only when that is v4+) is the
    // ship gate; a v3-only probe has no live gate, so suppress the marker.
    const gate = gateVersion >= 4 && oppAgent.version === gateVersion ? '  [ship gate]' : '';
    console.log(
      `  vs ${oppId.padEnd(12)} ${winPct.toFixed(1).padStart(5)}%  ` +
        `(${(t?.winsLo ?? 0).toFixed(1)}/${total.toFixed(0)})  ` +
        `${dev >= 0 ? '+' : ''}${dev.toFixed(1)}${flag}${gate}`,
    );
    cells.push({ oppId, oppVersion: oppAgent.version, winPct, total });
  }
  // Compact, grep-friendly line for eyeballing two runs side by side.
  const summary = cells.map((c) => `${c.oppId} ${c.winPct.toFixed(1)}%`).join('  ');
  console.log(`  SUMMARY ${map}${label ? ` «${label}»` : ''}: ${summary}`);
  return cells;
}

/**
 * Cross-map verdict against the ship gate (the highest-version opponent). A new
 * strategy is only a real upgrade if it beats the live champion on EVERY map —
 * v3-pool Elo can certify a paper gain that loses head-to-head to what ships.
 */
function shipGateVerdict(
  maps: readonly MapKind[],
  cellsByMap: Map<MapKind, Cell[]>,
  challengerId: string,
  gateVersion: number,
): void {
  if (gateVersion < 4) {
    console.log(
      `\n(no v4+ opponent in the pool → no live-champion ship gate; per-opponent win% above is the signal.)`,
    );
    return;
  }
  const parts: string[] = [];
  let pass = true;
  let gateId = '';
  for (const map of maps) {
    const gate = cellsByMap.get(map)!.find((c) => c.oppVersion === gateVersion);
    if (!gate) continue;
    gateId = gate.oppId;
    parts.push(`${map} ${gate.winPct.toFixed(1)}%`);
    if (gate.winPct < 50) pass = false;
  }
  const verdict = pass
    ? 'BEATS LIVE — real upgrade'
    : 'does NOT beat live — not an upgrade yet (need ≥50% on every map)';
  console.log(
    `\nSHIP GATE  ${challengerId} vs ${gateId}:  ${parts.join('  ')}  →  ${verdict}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
