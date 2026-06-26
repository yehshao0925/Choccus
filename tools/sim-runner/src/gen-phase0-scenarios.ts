/**
 * Generate Phase 0 determinism fixtures.
 * Runs 5 scripted scenarios; outputs (seed, map_kind, num_players, winner_slot, duration_ticks).
 * Usage: npx tsx tools/sim-runner/src/gen-phase0-scenarios.ts > rl/tests/fixtures/phase0_scenarios.json
 */
import { createInitialState, tick } from '../../../client/src/sim/Sim';
import { makeFeelParams } from '../../../client/src/config/FeelParams';
import { NO_INPUT } from '../../../client/src/sim/InputBuffer';
import { ActionFlags, Direction, GamePhase } from '../../../shared/types';

const DEFAULT_FEEL = makeFeelParams();

function runScenario(
  seed: number,
  mapKind: string,
  numPlayers: number,
  inputFn: (t: number, slot: number) => { dir: number; action: number },
): { winner_slot: number | null; duration_ticks: number } {
  let state = createInitialState(seed, DEFAULT_FEEL, numPlayers, { map: mapKind as any });
  while (state.phase === GamePhase.PLAYING && state.tick < 10800) {
    const inputs = state.players.map((_: any, i: number) => inputFn(state.tick, i));
    state = tick(state, inputs);
  }
  const alive = state.players.filter((p: any) => p.alive);
  const winner_slot = alive.length === 1 ? alive[0]!.slot : null;
  return { winner_slot, duration_ticks: state.tick };
}

const SCENARIOS = [
  // Scenario 0: All players stand still — game runs to sudden death
  {
    seed: 0, map_kind: 'classic', num_players: 2,
    input_fn: (_t: number, _slot: number) => ({ dir: 0, action: 0 }),
  },
  // Scenario 1: Player 0 places bomb tick 0, both stand still
  {
    seed: 1, map_kind: 'classic', num_players: 2,
    input_fn: (t: number, slot: number) => ({
      dir: 0,
      action: (t === 0 && slot === 0) ? ActionFlags.BOMB : 0,
    }),
  },
  // Scenario 2: pirate map, players move toward each other
  {
    seed: 2, map_kind: 'pirate', num_players: 2,
    input_fn: (_t: number, slot: number) => ({
      dir: slot === 0 ? Direction.RIGHT : Direction.LEFT,
      action: 0,
    }),
  },
  // Scenario 3: All 4 players, classic, drop bombs tick 5
  {
    seed: 3, map_kind: 'classic', num_players: 4,
    input_fn: (t: number, _slot: number) => ({
      dir: 0,
      action: t === 5 ? ActionFlags.BOMB : 0,
    }),
  },
  // Scenario 4: chain explosion (players move toward each other then bomb at tick 30)
  {
    seed: 4, map_kind: 'classic', num_players: 2,
    input_fn: (t: number, slot: number) => ({
      dir: t < 10 ? (slot === 0 ? Direction.RIGHT : Direction.LEFT) : 0,
      action: t === 30 ? ActionFlags.BOMB : 0,
    }),
  },
];

const results = SCENARIOS.map(({ seed, map_kind, num_players, input_fn }) => {
  const res = runScenario(seed, map_kind, num_players, input_fn);
  return { seed, map_kind, num_players, ...res };
});

process.stdout.write(JSON.stringify(results, null, 2));
