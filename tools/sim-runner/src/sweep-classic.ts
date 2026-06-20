/**
 * THROWAWAY tuning harness — DO NOT SHIP. Delete after the classic MapProfile
 * sweep is done. (Listed nowhere in package.json scripts; run via tsx directly.)
 *
 * Runs the CLASSIC-ONLY 8-agent 1v1 round-robin (the same fixed agent order and
 * match discipline as matrix-bench.ts) with ONE candidate CLASSIC MapProfile
 * injected into the v2 bots, then prints a compact ranking + a single RESULT
 * line. The injection rides the ship-safe `profileOverride` ctor seam on v2's
 * BotController and the optional `makeCtrl` factory on runMatchSeeded — v1 bots
 * are built exactly as the live bench builds them, so a NEUTRAL candidate
 * reproduces matrix-bench's classic ranking byte-for-byte (the parity check).
 *
 *   tsx src/sweep-classic.ts [--survEnough=N] [--disc=N] [--stay=N]
 *                            [--release=0|1] [--repeats=N] [--label=str]
 *
 *   --survEnough=N  classic profile survEnough. SPECIAL: 0 (DEFAULT) means
 *                   Number.MAX_SAFE_INTEGER (no clamp). Any positive N verbatim.
 *   --disc=N        deferredBombDiscountPct (default 0).
 *   --stay=N        stayPenalty (default 0).
 *   --release=0|1   deadlockGrowthRelease (default 1 = true).
 *   --repeats=N     forward+reverse repeats per pairing (default 5).
 *   --label=str     optional echo label for the result line.
 *
 * Determinism discipline (same as the live benches): no Date / Math.random /
 * performance / Math.sqrt. Every seed is the pure CRN scenarioSeed(0, r).
 */
import {
  ARCHETYPE_KEYS,
  type Agent,
  capitalize,
  combinations,
  makeAgent,
  makeController,
  padL,
  padR,
  runMatchSeeded,
} from './bench-utils';
import { scenarioSeed } from './matrix-runner';
import type { IBotController } from '../../../client/src/ai/index';
import {
  type GameOutcome,
  type WinMatrix,
  buildWinMatrix,
  decideVerdict,
  findThreeCycles,
  overallScores,
  rankAgents,
} from './matrix-stats';

import { BotController } from '../../../client/src/ai/v2/BotController';
import { botSeed } from '../../../client/src/ai/v2/BotConfig';
import { resolveStrategy } from '../../../client/src/ai/v2/Strategies';
import type { MapProfile } from '../../../client/src/ai/v2/MapProfile';

/** classic mapIndex into MAPS == 0 (MAPS = ['classic', 'pirate']). */
const CLASSIC_MAP_INDEX = 0;
/** Fixed 1v1 player count (two contestants, each its own team). */
const DUEL_N = 2;

/** One parsed candidate + run config. */
interface Options {
  survEnough: number; // verbatim CLI value; 0 = "no clamp" sentinel.
  disc: number;
  stay: number;
  release: boolean;
  repeats: number;
  label: string;
}

/** Scan argv for `--flag=value` (mirrors the matrix-bench parseArgs style). */
function parseArgs(argv: string[]): Options {
  let survEnough = 0;
  let disc = 0;
  let stay = 0;
  let release = true;
  let repeats = 5;
  let label = '';

  for (const arg of argv) {
    if (arg.startsWith('--survEnough=')) {
      survEnough = Number(arg.slice('--survEnough='.length));
    } else if (arg.startsWith('--disc=')) {
      disc = Number(arg.slice('--disc='.length));
    } else if (arg.startsWith('--stay=')) {
      stay = Number(arg.slice('--stay='.length));
    } else if (arg.startsWith('--release=')) {
      release = Number(arg.slice('--release='.length)) !== 0;
    } else if (arg.startsWith('--repeats=')) {
      repeats = Number(arg.slice('--repeats='.length));
    } else if (arg.startsWith('--label=')) {
      label = arg.slice('--label='.length);
    }
  }

  return { survEnough, disc, stay, release, repeats, label };
}

/**
 * Build the 8 agents in the SAME fixed order matrix-bench uses: version-major,
 * archetype-minor. Indices 0..3 = v1-{archetypes}, 4..7 = v2-{archetypes}.
 */
function buildAgents(): Agent[] {
  const agents: Agent[] = [];
  for (const v of [1, 2]) {
    for (const key of ARCHETYPE_KEYS) agents.push(makeAgent(v, key));
  }
  return agents;
}

/** The candidate CLASSIC profile this sweep injects into every v2 bot. */
function candidateProfile(opts: Options): MapProfile {
  return {
    map: 'classic',
    survEnough:
      opts.survEnough === 0 ? Number.MAX_SAFE_INTEGER : opts.survEnough,
    deferredBombDiscountPct: opts.disc,
    stayPenalty: opts.stay,
    deadlockGrowthRelease: opts.release,
  };
}

/**
 * Controller factory passed to runMatchSeeded. v1 agents are built EXACTLY as
 * the live bench builds them (makeController). v2 agents are built like
 * v2Module.createBot for a named archetype, PLUS the candidate profile injected
 * through the ship-safe profileOverride ctor seam.
 */
function makeCtrlFactory(
  profile: MapProfile,
): (agent: Agent, seed: number, slot: number) => IBotController {
  return (agent, seed, slot) => {
    if (agent.version === 1) {
      return makeController(1, agent.archetypeKey, seed, slot);
    }
    const tuning = resolveStrategy(agent.archetypeKey)!.tuning;
    return new BotController(botSeed(seed, slot), tuning, slot, profile);
  };
}

/** Run the classic-only round-robin, returning every game's outcome. */
function runSchedule(agents: Agent[], opts: Options): GameOutcome[] {
  const profile = candidateProfile(opts);
  const makeCtrl = makeCtrlFactory(profile);
  const pairs = combinations(
    Array.from({ length: agents.length }, (_, i) => i),
    2,
  );

  const outcomes: GameOutcome[] = [];
  for (const [i, j] of pairs) {
    for (let r = 0; r < opts.repeats; r++) {
      const seed = scenarioSeed(CLASSIC_MAP_INDEX, r);
      // Forward: i in slot 0, j in slot 1. (undefined maxTicks → default cap.)
      const fwd = runMatchSeeded(seed, [i!, j!], agents, 'classic', DUEL_N, undefined, makeCtrl);
      outcomes.push({ agentA: i!, agentB: j!, winnerAgent: fwd.winnerAgent });
      // Reverse: same seed, seats swapped.
      const rev = runMatchSeeded(seed, [j!, i!], agents, 'classic', DUEL_N, undefined, makeCtrl);
      outcomes.push({ agentA: j!, agentB: i!, winnerAgent: rev.winnerAgent });
    }
  }
  return outcomes;
}

/** Print the overall ranking table (rank / agent / overall win%) — like matrix-bench. */
function printRanking(agents: Agent[], scores: number[], ranked: number[]): void {
  const headers = ['Rank', 'Agent', 'Overall'];
  const cells = ranked.map((idx, i) => [
    String(i + 1),
    agents[idx]!.label,
    `${(scores[idx]! * 100).toFixed(1)}%`,
  ]);
  const widths = headers.map((h, c) =>
    Math.max(h.length, ...cells.map((row) => row[c]!.length)),
  );
  const fmtRow = (row: string[]): string =>
    row
      .map((cell, c) => (c === 1 ? padR(cell, widths[c]!) : padL(cell, widths[c]!)))
      .join('  ');
  console.log(fmtRow(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) console.log(fmtRow(row));
}

function main(): number {
  const opts = parseArgs(process.argv.slice(2));
  const agents = buildAgents();
  const label = opts.label === '' ? '(none)' : opts.label;

  const outcomes = runSchedule(agents, opts);
  const matrix: WinMatrix = buildWinMatrix(outcomes, agents.length);
  const scores = overallScores(matrix);
  const ranked = rankAgents(scores);
  const verdict = decideVerdict(matrix, ranked, findThreeCycles(matrix));
  void verdict; // computed per spec; the compact RESULT line keys off the ranking.

  // Header line echoing the candidate.
  console.log(
    `CANDIDATE ${label} survEnough=${opts.survEnough} disc=${opts.disc} ` +
      `stay=${opts.stay} release=${opts.release ? 1 : 0} repeats=${opts.repeats}`,
  );

  printRanking(agents, scores, ranked);

  // Compact RESULT line.
  const rank1Idx = ranked[0]!;
  const rank1Agent = agents[rank1Idx]!;
  const rank1IsV2 = rank1Agent.version === 2;

  // Best v2 agent by rank (lowest rank number = highest standing).
  const rankOf = (idx: number): number => ranked.indexOf(idx) + 1;
  let bestV2Idx = -1;
  for (const idx of ranked) {
    if (agents[idx]!.version === 2) {
      bestV2Idx = idx;
      break;
    }
  }
  const bestV2 = agents[bestV2Idx]!;
  const bestV2Rank = rankOf(bestV2Idx);
  const bestV2Win = `${(scores[bestV2Idx]! * 100).toFixed(1)}%`;

  // Per-archetype v2 standings, in ARCHETYPE_KEYS order.
  const v2Parts: string[] = [];
  for (const key of ARCHETYPE_KEYS) {
    const idx = agents.findIndex((a) => a.version === 2 && a.archetypeKey === key);
    v2Parts.push(
      `${capitalize(key)}#${rankOf(idx)}(${(scores[idx]! * 100).toFixed(1)}%)`,
    );
  }

  console.log(
    `RESULT ${label}: rank1=${rank1Agent.label} isV2=${rank1IsV2 ? 'yes' : 'no'} | ` +
      `bestV2=${bestV2.label}@#${bestV2Rank}(${bestV2Win}) | ` +
      `v2ranks: ${v2Parts.join(' ')}`,
  );
  console.log(rank1IsV2 ? 'PASS' : 'FAIL');

  return 0;
}

process.exit(main());
