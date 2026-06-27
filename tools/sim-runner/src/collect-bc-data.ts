/**
 * Collect BC training data: run v6:hunter self-play games and save
 * action sequences to JSONL. Python replays them via the deterministic Python sim.
 *
 * Usage (from tools/sim-runner/):
 *   npm run collect-bc -- --games=1000 --map=classic --out=../../rl/data/bc_classic.jsonl
 */
import { createWriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { AI_VERSIONS } from '../../../client/src/ai/index';
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { ActionFlags, Direction, GamePhase } from '../../../shared/types';

const FEEL = makeFeelParams();
const NUM_PLAYERS = 2;
const MAX_TICKS = 10_800;

/**
 * Map InputFrame → action index matching Python _ACTION_MAP:
 *   0=stay, 1=up, 2=down, 3=left, 4=right, 5=bomb
 * If bomb flag is set (even with a direction), record as bomb=5.
 */
function toActionIdx(dir: number, action: number): number {
  if (action & ActionFlags.BOMB) return 5;
  if (dir === Direction.UP)    return 1;
  if (dir === Direction.DOWN)  return 2;
  if (dir === Direction.LEFT)  return 3;
  if (dir === Direction.RIGHT) return 4;
  return 0;
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      games:  { type: 'string', default: '1000' },
      map:    { type: 'string', default: 'classic' },
      out:    { type: 'string', default: '../../rl/data/bc_classic.jsonl' },
      offset: { type: 'string', default: '0' },
    },
    strict: false,
  });

  const numGames   = parseInt(values.games  as string, 10);
  const mapKind    = values.map    as string;
  const outPath    = values.out    as string;
  const seedOffset = parseInt(values.offset as string, 10);

  const outDir = outPath.substring(0, outPath.lastIndexOf('/'));
  if (outDir) mkdirSync(outDir, { recursive: true });

  const stream = createWriteStream(outPath, { flags: 'w' });

  for (let g = 0; g < numGames; g++) {
    const seed = seedOffset + g;

    let state = createInitialState(seed, FEEL, NUM_PLAYERS, { map: mapKind as any });

    const bots = [0, 1].map(slot =>
      AI_VERSIONS[6].createBot(seed + slot * 1_000_000, slot, {
        difficulty:  'hard',
        strategyRaw: 'hunter',
      })
    );

    const ticks: number[][] = [];
    while (state.phase === GamePhase.PLAYING && state.tick < MAX_TICKS) {
      const inputs = bots.map((bot, slot) => bot.sample(state, slot));
      ticks.push(inputs.map(f => toActionIdx(f.dir, f.action)));
      state = tick(state, inputs);
    }

    const line = JSON.stringify({ seed, map_kind: mapKind, num_players: NUM_PLAYERS, ticks });
    stream.write(line + '\n');

    if ((g + 1) % 100 === 0) {
      process.stderr.write(`${g + 1}/${numGames} games collected\n`);
    }
  }

  await new Promise<void>(resolve => stream.end(resolve));
  process.stderr.write(`\nSaved ${numGames} games to ${outPath}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
