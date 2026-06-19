/** Dump the classic spawn-corner neighbourhood: tile kinds + open passability. */
import { createInitialState } from '../../../client/src/sim/Sim';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { TileKind } from '../../../shared/types';
import { idx } from '../../../client/src/sim/Map';

const map = (process.argv[2] ?? 'classic') as 'classic' | 'pirate';
const seed = Number(process.argv[3] ?? 305419896);
const state = createInitialState(seed, makeFeelParams(), 2, {
  pvp: true,
  teams: [0, 1],
  map,
});

const COLS = 15;
const ROWS = 13;
function kindChar(k: number): string {
  if (k === TileKind.HARD) return '#';
  if (k === TileKind.SOFT) return 'x';
  return '.';
}
console.log(`map=${map} seed=${seed}  (# hard, x soft, . floor; P=spawn)`);
const spawns = state.players.map((p) => idx(Math.round(p.posX / 1000), Math.round(p.posY / 1000)));
void spawns;
for (let y = 0; y < ROWS; y++) {
  let row = '';
  for (let x = 0; x < COLS; x++) {
    const k = state.map[idx(x, y)] ?? 0;
    let c = kindChar(k);
    for (const p of state.players) {
      const px = Math.round(p.posX / 1000);
      const py = Math.round(p.posY / 1000);
      if (px === x && py === y) c = 'P';
    }
    row += c;
  }
  console.log(row);
}
console.log('players:');
for (const p of state.players) {
  console.log(
    `  slot${p.slot} pos=(${Math.round(p.posX / 1000)},${Math.round(p.posY / 1000)}) fire=${p.fire} cannon=${p.cannon}`,
  );
}
