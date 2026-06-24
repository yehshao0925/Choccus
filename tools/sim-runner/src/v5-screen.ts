/**
 * v5-screen — FAST, noise-tolerant A/B screen for a candidate strategy change,
 * with sequential EARLY-STOP. The cheap first filter BEFORE the slow authoritative
 * eval (bt-rank): it answers "did this change move the needle enough to be worth a
 * full evaluation?" in ~1 min instead of v5-probe's ~6, and tolerates noise by
 * design — it is a screen, not a verdict.
 *
 * Why it can be fast (the key idea): the CRN scenario seed is a pure function of
 * (mapIndex, repeat) and is INDEPENDENT of any code/flag change. So game
 * (opponent, repeat, seating) uses the IDENTICAL seed in a baseline run and a
 * candidate run — the two runs are PAIRED per seed. A paired comparison cancels
 * the per-seed map/▒luck variance, so a real effect shows up at a FRACTION of the
 * sample size an unpaired win% needs. We exploit that without any bot plumbing:
 *
 *   1) once per champion:  npm run v5-screen -- --save-baseline   (flag OFF)
 *      → stores committed v5's per-game result for every (opponent, repeat, seat).
 *   2) per candidate:      flip the experimental flag ON, then
 *      npm run v5-screen                                          (flag ON)
 *      → re-runs the SAME seeds, PAIRS each game vs the saved baseline, and after
 *        each block runs a paired z-test; it EARLY-STOPS the moment the signal is
 *        clearly + / − / flat, or hits --max-repeats (INCONCLUSIVE).
 *
 * Verdict (loose by design — Z_SIG = 1.5, so it flags promising candidates and
 * accepts some false positives; the full bt-rank is the real gate):
 *   - ESCALATE : a non-gate opponent is significantly BETTER and the ship gate is
 *                not significantly worse → run the full bt-rank both maps.
 *   - DROP     : the ship gate (or any tracked opponent) is significantly WORSE.
 *   - INCONCLUSIVE: no significant paired movement by --max-repeats.
 *
 *   npm run v5-screen -- [--target=v5:zoner] [--opponents=v4:zoner,v3:trapper]
 *     [--map=pirate] [--max-repeats=24] [--block=6] [--min-repeats=8]
 *     [--save-baseline] [--workers=8]
 *
 * Default opponents = ship gate (v4:zoner) + the usual binding mirror (v3:trapper);
 * NOTE the target's own version is excluded by default because flipping a v5 flag
 * changes BOTH sides of a v5 mirror (uninformative). Read-only on history; the only
 * file it writes is the baseline cache (screen-baseline-<map>.json, gitignored use).
 *
 * tools/ script (not sim/** or ai/**): floats / Math.* are fine here.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAPS, type Agent, type MapKind } from './bench-utils';
import { type Game, runAllGames, scenarioSeed } from './matrix-runner';
import { arg, duelCredit, idOf, parseChallenger } from './bt-common';

/** Loose screen threshold: |z| above this on the paired diff = a signal. */
const Z_SIG = 1.5;

/** Per-game paired credit cache: key "oppId|repeat|seat" → target win credit. */
type PerGame = Record<string, number>;

/** Sidecar identity for a scheduled game (Game itself can't carry extra fields). */
interface GameMeta {
  oppId: string;
  repeat: number;
  seat: 0 | 1;
}

function baselinePath(map: MapKind): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', `screen-baseline-${map}.json`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = parseChallenger(arg(argv, 'target', 'v5:zoner'));
  const oppSpec = arg(argv, 'opponents', 'v4:zoner,v3:trapper');
  const opponents = oppSpec.split(',').map((s) => parseChallenger(s.trim()));
  const mapArg = arg(argv, 'map', 'pirate') as MapKind;
  const map = MAPS.includes(mapArg) ? mapArg : 'pirate';
  const mapIndex = MAPS.indexOf(map);
  const maxRepeats = Number(arg(argv, 'max-repeats', '24'));
  const block = Number(arg(argv, 'block', '6'));
  const minRepeats = Number(arg(argv, 'min-repeats', '8'));
  const workers = Number(arg(argv, 'workers', '8'));
  const saveBaseline = argv.includes('--save-baseline');

  // Pool = [target, ...opponents]; target is index 0.
  const agents: Agent[] = [target, ...opponents];
  const targetIdx = 0;

  const mode = saveBaseline ? 'SAVE-BASELINE' : 'SCREEN';
  console.log(
    `v5-screen [${mode}] — ${idOf(target)} vs [${opponents.map(idOf).join(', ')}]  map=${map}\n` +
      `  paired CRN, early-stop (block=${block}, min=${minRepeats}, max=${maxRepeats}), workers=${workers}`,
  );

  let baseline: PerGame | null = null;
  if (!saveBaseline) {
    const bp = baselinePath(map);
    if (!fs.existsSync(bp)) {
      console.log(
        `\n  no baseline cache at ${path.basename(bp)} — run once with --save-baseline ` +
          `(committed champion, flag OFF) first, then flip your flag ON and re-run.`,
      );
      process.exit(2);
    }
    baseline = JSON.parse(fs.readFileSync(bp, 'utf8')) as PerGame;
  }

  // Accumulated per-game credit (this run) + per-opponent paired diff samples.
  const thisRun: PerGame = {};
  const diffs = new Map<string, number[]>(); // oppId → paired diffs (cand − base)
  for (const o of opponents) diffs.set(idOf(o), []);

  let ran = 0;
  for (let start = 0; start < maxRepeats; start += block) {
    const end = Math.min(start + block, maxRepeats);
    const { games, metas } = buildGames(targetIdx, opponents, mapIndex, map, start, end);
    const results = await runAllGames(games, agents, { workers });

    // Fold this block's per-game credit + (screen mode) paired diffs.
    for (let i = 0; i < games.length; i++) {
      const meta = metas[i]!; // results are gameId-ordered, == games/metas order
      const credit = duelCredit(results[i]!.record, targetIdx); // target's win credit
      const key = `${meta.oppId}|${meta.repeat}|${meta.seat}`;
      thisRun[key] = credit;
      if (baseline) {
        const base = baseline[key];
        if (base !== undefined) diffs.get(meta.oppId)!.push(credit - base);
      }
    }
    ran = end;

    if (saveBaseline) continue;
    // After each block (past the warm-up), test for a terminal verdict.
    if (ran >= minRepeats) {
      const verdict = evaluate(opponents, diffs);
      printProgress(ran, opponents, diffs);
      if (verdict.terminal) {
        printVerdict(verdict, ran);
        return;
      }
    }
  }

  if (saveBaseline) {
    fs.writeFileSync(baselinePath(map), JSON.stringify(thisRun, null, 0) + '\n');
    console.log(`\n  saved baseline (${Object.keys(thisRun).length} games) → ${path.basename(baselinePath(map))}`);
    console.log('  now flip your experimental flag ON and run `npm run v5-screen` to screen it.');
    return;
  }
  // Ran to max without a terminal verdict.
  printProgress(ran, opponents, diffs);
  printVerdict(evaluate(opponents, diffs), ran);
}

/** Build target-vs-opponents games for repeats [start,end), both seatings, CRN.
 * Returns games + a parallel metas array (same index/order) since Game can't carry
 * extra fields and results come back gameId-ordered (== build order). */
function buildGames(
  targetIdx: number,
  opponents: Agent[],
  mapIndex: number,
  map: MapKind,
  start: number,
  end: number,
): { games: Game[]; metas: GameMeta[] } {
  const games: Game[] = [];
  const metas: GameMeta[] = [];
  let gameId = 0;
  for (let oi = 0; oi < opponents.length; oi++) {
    const oppIdx = oi + 1; // pool index (target is 0)
    const oppId = idOf(opponents[oi]!);
    for (let r = start; r < end; r++) {
      const seed = scenarioSeed(mapIndex, r);
      games.push({ gameId: gameId++, mapKind: map, seed, slot0Agent: targetIdx, slot1Agent: oppIdx });
      metas.push({ oppId, repeat: r, seat: 0 });
      games.push({ gameId: gameId++, mapKind: map, seed, slot0Agent: oppIdx, slot1Agent: targetIdx });
      metas.push({ oppId, repeat: r, seat: 1 });
    }
  }
  return { games, metas };
}

interface Verdict {
  terminal: boolean;
  kind: 'ESCALATE' | 'DROP' | 'INCONCLUSIVE';
  reason: string;
}

/** Paired z-test per opponent → an aggregate screen verdict. */
function evaluate(opponents: Agent[], diffs: Map<string, number[]>): Verdict {
  // The ship gate = the highest-version opponent (must not be significantly worse).
  const gate = opponents.reduce((a, b) => (b.version >= a.version ? b : a));
  const gateId = idOf(gate);
  let anyBetter = false;
  let worseId: string | null = null;
  for (const o of opponents) {
    const z = pairedZ(diffs.get(idOf(o))!);
    if (z < -Z_SIG) worseId = idOf(o);
    if (idOf(o) !== gateId && z > Z_SIG) anyBetter = true;
  }
  const gateZ = pairedZ(diffs.get(gateId)!);
  if (gateZ < -Z_SIG) {
    return { terminal: true, kind: 'DROP', reason: `ship gate ${gateId} significantly worse (z=${gateZ.toFixed(1)})` };
  }
  if (worseId) {
    return { terminal: true, kind: 'DROP', reason: `${worseId} significantly worse — collateral damage` };
  }
  if (anyBetter) {
    return { terminal: true, kind: 'ESCALATE', reason: 'a tracked opponent significantly better, gate not worse → run bt-rank' };
  }
  return { terminal: false, kind: 'INCONCLUSIVE', reason: 'no significant paired movement yet' };
}

/** z = mean / standard-error of the paired diffs (0 if too few / no spread). */
function pairedZ(d: number[]): number {
  const n = d.length;
  if (n < 2) return 0;
  const mean = d.reduce((s, x) => s + x, 0) / n;
  let v = 0;
  for (const x of d) v += (x - mean) * (x - mean);
  v /= n - 1;
  const se = Math.sqrt(v / n);
  return se < 1e-9 ? 0 : mean / se;
}

function printProgress(ran: number, opponents: Agent[], diffs: Map<string, number[]>): void {
  const parts = opponents.map((o) => {
    const d = diffs.get(idOf(o))!;
    const mean = d.length ? (d.reduce((s, x) => s + x, 0) / d.length) * 100 : 0;
    const z = pairedZ(d);
    const tag = z > Z_SIG ? '↑' : z < -Z_SIG ? '↓' : '·';
    return `${idOf(o)} ${mean >= 0 ? '+' : ''}${mean.toFixed(1)}%${tag}(z${z >= 0 ? '+' : ''}${z.toFixed(1)})`;
  });
  console.log(`  @${ran} rep  paired Δ:  ${parts.join('   ')}`);
}

function printVerdict(v: Verdict, ran: number): void {
  console.log(`\n  VERDICT @${ran} rep: ${v.kind} — ${v.reason}`);
  if (v.kind === 'ESCALATE') console.log('  → next: npm run bt-rank -- --target=<v>:zoner --map=<both maps>');
  if (v.kind === 'INCONCLUSIVE') console.log('  → no clear signal: drop it, or raise --max-repeats for a finer look.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
