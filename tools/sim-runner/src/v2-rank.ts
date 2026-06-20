/**
 * Rank v2 archetypes against EACH OTHER on a map (default classic), 1v1, to find
 * the strongest v2 — the gate target for v3. Round-robin, both seatings, CRN.
 *   npm run -s tsx src/v2-rank.ts -- [--map=classic] [--repeats=40]
 */
import { BASE, type MapKind, makeAgent, runMatchSeeded } from './bench-utils';

const ARCHES = ['aggressor', 'turtle', 'gambler', 'chaosv'];

const argv = process.argv.slice(2);
const get = (k: string, d: string): string => {
  const a = argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const map = get('map', 'classic') as MapKind;
const repeats = Number(get('repeats', '40'));

// wins[i] accumulates archetype i's win share (draws 0.5) over all its games.
const wins = ARCHES.map(() => 0);
const games = ARCHES.map(() => 0);
let gi = 0;
for (let i = 0; i < ARCHES.length; i++) {
  for (let j = i + 1; j < ARCHES.length; j++) {
    for (let r = 0; r < repeats; r++) {
      const seed = (BASE + r) >>> 0;
      const agents = [makeAgent(2, ARCHES[i]!), makeAgent(2, ARCHES[j]!)];
      for (const slot of [[0, 1], [1, 0]]) {
        const rec = runMatchSeeded(seed + gi * 0, slot, agents, map, 2);
        gi++;
        games[i]!++; games[j]!++;
        if (rec.winnerAgent === null) { wins[i]! += 0.5; wins[j]! += 0.5; }
        else if (rec.winnerAgent === 0) wins[i]! += 1;
        else wins[j]! += 1;
      }
    }
  }
}

console.log(`v2 archetype strength on ${map} (1v1 round-robin, ${repeats} reps × 2 seatings, draws=0.5):`);
const rows = ARCHES.map((a, i) => ({ a, rate: wins[i]! / games[i]! }));
rows.sort((x, y) => y.rate - x.rate);
for (const row of rows) console.log(`  v2-${row.a.padEnd(10)} ${(row.rate * 100).toFixed(1)}%`);
console.log(`STRONGEST v2 on ${map}: v2-${rows[0]!.a} (${(rows[0]!.rate * 100).toFixed(1)}%)`);
process.exit(0);
